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

  const { error } = await supabase
    .from('tasks')
    .upsert(
      tasks.map((t) => ({ ...t, user_id: userId })),
      { onConflict: 'id' }
    );

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── AI 계획 생성 ────────────────────────────────────
app.post('/ai/plan', authMiddleware, async (req, res) => {
  const { goal, detail, duration, startDate } = req.body;

  if (!goal) return res.status(400).json({ error: '목표를 입력해주세요.' });

  try {
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // 주차별 날짜 범위 계산
    const start = new Date(startDate || new Date());
    const weekCount = parseInt(duration) || 1;
    const weekRanges = [];
    for (let w = 0; w < weekCount; w++) {
      const weekStart = new Date(start);
      weekStart.setDate(start.getDate() + w * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      weekRanges.push(`${w+1}주차: ${weekStart.getMonth()+1}월 ${weekStart.getDate()}일(월) ~ ${weekEnd.getMonth()+1}월 ${weekEnd.getDate()}일(일)`);
    }

    const prompt = `당신은 개인 플래너 AI 어시스턴트입니다.

[절대 규칙]
- 모든 텍스트는 100% 순수 한국어(한글)로만 작성하세요.
- 한자, 일본어, 영어 등 외국어를 절대 사용하지 마세요.
- 반드시 유효한 JSON 형식으로만 응답하세요. 다른 텍스트 없이 JSON만 출력하세요.
- weeks 배열에 반드시 ${weekCount}개의 주차 데이터를 모두 포함하세요.
- 각 주차의 days 배열에는 월,화,수,목,금,토,일 7개 요일이 모두 있어야 합니다.
- 각 할 일은 15자 이내 한글로 작성하세요.

사용자 목표: "${goal}"
세부 사항: "${detail || '없음'}"
기간: ${weekCount}주
시작 날짜: ${startDate}
주차별 날짜:
${weekRanges.join('\n')}

응답 형식:
{
  "rejected": false,
  "weeks": [
    {
      "week": 1,
      "theme": "1주차 목표 한글",
      "days": [
        { "day": "월", "tasks": ["할 일1", "할 일2"] },
        { "day": "화", "tasks": ["할 일1"] },
        { "day": "수", "tasks": ["할 일1"] },
        { "day": "목", "tasks": ["할 일1"] },
        { "day": "금", "tasks": ["할 일1"] },
        { "day": "토", "tasks": [] },
        { "day": "일", "tasks": [] }
      ]
    }
  ]
}

목표가 너무 추상적이면: { "rejected": true, "message": "더 구체적인 목표를 입력해주세요." }

반드시 ${weekCount}주차 데이터를 전부 생성하고, JSON만 출력하세요.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 3000,
    });

    const text = completion.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 파싱 실패');

    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    res.status(500).json({ error: 'AI 오류: ' + err.message });
  }
});

// ── AI 주간 분석 ────────────────────────────────────
app.post('/ai/analyze', authMiddleware, async (req, res) => {
  const { tasks } = req.body;

  try {
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const prompt = `다음은 사용자의 최근 2주 플래너 데이터입니다:
${JSON.stringify(tasks, null, 2)}

분석 후 다음 JSON 형식으로만 응답하세요:
{
  "completionRate": 75,
  "insight": "분석 인사이트 텍스트",
  "nextWeekPlan": {
    "week": 1,
    "days": {
      "월": ["추천 할일1"],
      "화": ["추천 할일1"],
      "수": [],
      "목": [],
      "금": [],
      "토": [],
      "일": []
    }
  }
}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2000,
    });

    const text = completion.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 파싱 실패');

    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    res.status(500).json({ error: 'AI 오류: ' + err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`memota-back running on port ${PORT}`));

module.exports = app;
