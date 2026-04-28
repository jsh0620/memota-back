// index.js (경로: memota-back/index.js)
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const JWT_SECRET = process.env.JWT_SECRET || 'memota-secret-key';

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'memota-back running' });
});

app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || username.length < 3)
    return res.status(400).json({ error: '아이디는 3자 이상이어야 합니다.' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });

  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', username)
    .single();

  if (existing)
    return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });

  const hashedPassword = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from('profiles')
    .insert([{ username, password: hashedPassword }])
    .select()
    .single();

  if (error)
    return res.status(500).json({ error: '회원가입 실패: ' + error.message });

  const token = jwt.sign({ userId: data.id, username }, JWT_SECRET, {
    expiresIn: '30d',
  });

  res.json({ token, user: { id: data.id, username } });
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;

  const { data: user, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('username', username)
    .single();

  if (error || !user)
    return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid)
    return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });

  const token = jwt.sign(
    { userId: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({ token, user: { id: user.id, username: user.username } });
});

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: '인증 토큰 없음' });

  try {
    const token = auth.replace('Bearer ', '');
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: '유효하지 않은 토큰' });
  }
}

app.get('/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ── 할 일 조회 ──────────────────────────────────────
app.get('/tasks/:userId', authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: data || [] });
});

// ── 할 일 저장 ──────────────────────────────────────
app.put('/tasks/:userId', authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { tasks } = req.body;

  if (!tasks || !Array.isArray(tasks)) {
    return res.status(400).json({ error: 'tasks 배열이 필요합니다.' });
  }

  try {
    const { error: deleteError } = await supabase
      .from('tasks')
      .delete()
      .eq('user_id', userId);

    if (deleteError) throw deleteError;

    if (tasks.length > 0) {
      const { error: insertError } = await supabase
        .from('tasks')
        .insert(
          tasks.map((t) => ({
            id: t.id,
            user_id: userId,
            text: t.text,
            completed: t.completed,
            date: t.date,
            category: t.category || '기타',
            time: t.time || '',
          }))
        );

      if (insertError) throw insertError;
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '저장 실패: ' + err.message });
  }
});

// ── 보관함 조회 ─────────────────────────────────────
app.get('/archive/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await supabase
      .from('archives')
      .select('archive_data')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ error: '불러오기 실패' });
    }

    return res.json({ archive: data?.archive_data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── 보관함 저장 ─────────────────────────────────────
app.put('/archive/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { archive } = req.body;

    const { error } = await supabase
      .from('archives')
      .upsert(
        { user_id: userId, archive_data: archive },
        { onConflict: 'user_id' }
      );

    if (error) return res.status(500).json({ error: '저장 실패' });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── AI 계획 생성 ────────────────────────────────────
app.post('/ai/plan', authMiddleware, async (req, res) => {
  const { goal, detail } = req.body;

  if (!goal) return res.status(400).json({ error: '목표를 입력해주세요.' });

  try {
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const systemPrompt = `당신은 사용자의 목표를 분석하여 실천 가능한 계획을 설계하는 전문 코치입니다.

[절대 규칙]
1. 모든 텍스트는 100% 순수 한국어(한글)로만 작성합니다. 영어 단어도 한글 발음으로 표기합니다.
2. 반드시 유효한 JSON 형식으로만 응답합니다. 코드블록이나 설명 텍스트를 절대 붙이지 않습니다.
3. 요일별 할 일은 최대 2개, 권장 1개로 제한합니다. 실천 가능성이 최우선입니다.
4. 각 할 일은 "무엇을 얼마나" 알 수 있는 구체적 행동으로 작성합니다. (나쁜 예: "공부하기" / 좋은 예: "단어 20개 암기")
5. 각 주차의 days 배열에는 반드시 월,화,수,목,금,토,일 순서로 7개 요일 객체가 모두 있어야 합니다.
6. tasks가 없는 날도 빈 배열 []로 반드시 포함합니다.

[반려 기준 - rejected: true로 응답]
- 목표가 단어 1~2개뿐이고 내용 파악이 불가한 경우 (예: "공부", "운동", "시험")
- 무엇을 할지 대상이 전혀 없는 경우 (예: "열심히 살기", "잘 되고 싶다")
- 의미 없는 단어 나열 (예: "ㅁㄴㅇ", "asdf", "테스트")
- 폭력적이거나 비윤리적인 내용

[정상 응답 형식]
{
  "rejected": false,
  "summary": "2문장 이내 계획 요약",
  "weeks": [
    {
      "week": 1,
      "theme": "이번 주 핵심 키워드 한 문장",
      "days": [
        { "day": "월", "tasks": ["구체적 행동 1개"] },
        { "day": "화", "tasks": ["구체적 행동 1개"] },
        { "day": "수", "tasks": ["구체적 행동 1개"] },
        { "day": "목", "tasks": ["구체적 행동 1개"] },
        { "day": "금", "tasks": ["구체적 행동 1개"] },
        { "day": "토", "tasks": ["복습 또는 정리"] },
        { "day": "일", "tasks": [] }
      ]
    }
  ]
}

[반려 응답 형식]
{ "rejected": true, "message": "친절하고 구체적인 안내 메시지" }`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `목표: ${goal}\n세부사항: ${detail || '없음'}\n\n요일별 할 일은 최대 2개, 가능하면 1개만 배치해줘.` }
      ],
      temperature: 0.25,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    });

    const text = completion.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 파싱 실패');

    const parsed = JSON.parse(jsonMatch[0]);

    // 요일별 최대 2개 강제 적용
    if (!parsed.rejected && Array.isArray(parsed.weeks)) {
      parsed.weeks.forEach(week => {
        if (Array.isArray(week.days)) {
          week.days.forEach(day => {
            if (Array.isArray(day.tasks) && day.tasks.length > 2) {
              day.tasks = day.tasks.slice(0, 2);
            }
          });
        }
      });
    }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: 'AI 오류: ' + err.message });
  }
});

// ── AI 주간 분석 ────────────────────────────────────
app.post('/ai/analyze', authMiddleware, async (req, res) => {
  const { tasks } = req.body;

  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: '분석할 데이터가 없습니다.' });
  }

  try {
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const now = new Date();
    const twoWeeksAgo = new Date(now);
    twoWeeksAgo.setDate(now.getDate() - 14);
    const recentTasks = tasks.filter(t => {
      const d = new Date(t.date);
      return d >= twoWeeksAgo && d <= now;
    });

    const total = recentTasks.length;
    const done  = recentTasks.filter(t => t.completed).length;
    const rate  = total > 0 ? Math.round((done / total) * 100) : 0;

    const DAY_KR = ['일', '월', '화', '수', '목', '금', '토'];
    const dayStats = {};
    recentTasks.forEach(t => {
      const day = DAY_KR[new Date(t.date).getDay()];
      if (!dayStats[day]) dayStats[day] = { total: 0, done: 0 };
      dayStats[day].total++;
      if (t.completed) dayStats[day].done++;
    });

    const systemPrompt = `당신은 개인 생산성 코치 AI입니다.

[절대 규칙]
1. 모든 텍스트는 100% 순수 한국어(한글)로만 작성합니다.
2. 반드시 유효한 JSON 형식으로만 응답합니다. 코드블록이나 설명을 절대 붙이지 않습니다.
3. 요일별 할 일은 최대 2개, 권장 1개로 제한합니다.
4. nextWeekPlan의 days 배열에는 반드시 월,화,수,목,금,토,일 순서로 7개 요일 객체가 모두 있어야 합니다.
5. tasks가 없는 날도 빈 배열 []로 반드시 포함합니다.
6. 톤은 따뜻하고 격려하는 말투를 사용합니다.

[응답 형식]
{
  "insights": ["인사이트 1", "인사이트 2", "다음 주 전략"],
  "bestDay": "월요일",
  "weakDay": "금요일",
  "nextWeekPlan": {
    "theme": "다음 주 핵심 목표 한 문장",
    "days": [
      { "day": "월", "tasks": ["구체적 행동 1개"] },
      { "day": "화", "tasks": [] },
      { "day": "수", "tasks": ["구체적 행동 1개"] },
      { "day": "목", "tasks": [] },
      { "day": "금", "tasks": ["구체적 행동 1개"] },
      { "day": "토", "tasks": [] },
      { "day": "일", "tasks": [] }
    ]
  }
}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `분석 데이터:\n- 전체 달성률: ${rate}% (총 ${total}개 중 ${done}개 완료)\n- 요일별 통계: ${JSON.stringify(dayStats)}\n- 최근 2주 할 일: ${JSON.stringify(recentTasks.map(t => ({ date: t.date, text: t.text, completed: t.completed })))}\n\n요일별 할 일은 최대 2개, 가능하면 1개만 배치해줘.` }
      ],
      temperature: 0.35,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    });

    const text = completion.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 파싱 실패');

    const parsed = JSON.parse(jsonMatch[0]);

    // 요일별 최대 2개 강제 적용
    if (parsed.nextWeekPlan?.days) {
      parsed.nextWeekPlan.days.forEach(d => {
        if (Array.isArray(d.tasks) && d.tasks.length > 2) {
          d.tasks = d.tasks.slice(0, 2);
        }
      });
    }

    res.json({ ...parsed, rate });
  } catch (err) {
    res.status(500).json({ error: 'AI 오류: ' + err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`memota-back running on port ${PORT}`));

module.exports = app;
