// index.js (경로: memota-back/api/index.js)
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' })); // ← 파일 데이터를 위해 limit 증가

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
  
  // ✅ DB → 프론트엔드 필드명 변환
  const tasks = (data || []).map(row => ({
    id: row.id,
    text: row.text,
    completed: row.completed,
    date: row.date,
    color: row.color,
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: row.start_time,
    endTime: row.end_time,
    files: row.files || [],
    groupId: row.group_id,
  }));
  
  res.json({ tasks });
});

// ── 할 일 저장 ──────────────────────────────────────
app.put('/tasks/:userId', authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { tasks } = req.body;

  if (!tasks || !Array.isArray(tasks)) {
    return res.status(400).json({ error: 'tasks 배열이 필요합니다.' });
  }

  try {
    // 1. DB 구조에 맞게 데이터 변환 (테이블에 없는 category, time, starred 제거)
    const dbTasks = tasks.map((t) => ({
      id: t.id,
      user_id: userId,
      text: t.text,
      completed: t.completed,
      date: t.date,
      color: t.color || null,
      start_date: t.startDate || null,
      end_date: t.endDate || null,
      start_time: t.startTime || null,
      end_time: t.endTime || null,
      files: t.files || [], // jsonb 타입
      group_id: t.groupId || null,
    }));

    // 2. Upsert 실행: ID가 같으면 업데이트, 없으면 삽입 (데이터 유실 방지)
    if (dbTasks.length > 0) {
      const { error: upsertError } = await supabase
        .from('tasks')
        .upsert(dbTasks, { onConflict: 'id' });

      if (upsertError) throw upsertError;
    }

    // 3. 삭제 처리: 현재 전달받은 목록에 없는 ID들만 DB에서 삭제
    const currentIds = tasks.map(t => t.id);
    const { error: deleteError } = await supabase
      .from('tasks')
      .delete()
      .eq('user_id', userId)
      .not('id', 'in', `(${currentIds.join(',')})`);

    if (deleteError) throw deleteError;

    res.json({ ok: true });
  } catch (err) {
    console.error('Save Error:', err.message);
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

// ── AI 계획 생성 ────────────────────────────────────
app.post('/ai/plan', authMiddleware, async (req, res) => {
  const { goal, detail, totalDays } = req.body;

  if (!goal) return res.status(400).json({ error: '목표를 입력해주세요.' });
  if (!totalDays || totalDays < 1 || totalDays > 14) {
    return res.status(400).json({ error: '기간은 1일~14일 사이여야 합니다.' });
  }

  try {
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const systemPrompt = `당신은 사용자의 목표를 분석하여 실천 가능한 N일차 계획을 설계하는 전문 코치입니다.

[절대 규칙 - 반드시 지켜야 함]
1. 모든 텍스트는 100% 순수 한국어(한글)로만 작성합니다.
   - 영어 단어(예: LC, RC, Part, Test)는 절대 사용 금지. 반드시 한글로 표기하세요.
   - 한자(예: 重点, 基本) 사용 절대 금지.
   - 영어가 포함된 고유명사도 한글 발음으로 표기하세요. (예: TOEIC → 토익, LC → 듣기, RC → 읽기)
2. 반드시 유효한 JSON 형식으로만 응답합니다. 코드블록이나 설명 텍스트를 절대 붙이지 않습니다.
3. 응답의 최상위 키는 반드시 "rejected", "summary", "days" 세 가지만 사용합니다. "weeks" 키는 절대 사용하지 마세요.
4. "days"는 반드시 배열(array) 형태이며, 각 원소는 {"day": 숫자, "tasks": [문자열]} 형식입니다.
5. day 값은 반드시 숫자(1, 2, 3...)여야 합니다. 문자열("월", "화" 등) 사용 금지.
6. 일별 할 일은 최대 2개, 권장 1개로 제한합니다.
7. 각 할 일은 구체적 행동으로 작성합니다. (나쁜 예: "공부하기" / 좋은 예: "단어 20개 암기")
8. tasks가 없는 날도 빈 배열 []로 반드시 포함합니다.

[반려 기준 - rejected: true로 응답]
- 목표가 단어 1~2개뿐이고 내용 파악이 불가한 경우 (예: "공부", "운동", "시험")
- 무엇을 할지 대상이 전혀 없는 경우 (예: "열심히 살기", "잘 되고 싶다")
- 의미 없는 단어 나열 (예: "ㅁㄴㅇ", "asdf", "테스트")
- 폭력적이거나 비윤리적인 내용

[정상 응답 형식 - 이 구조를 정확히 따르세요]
{
  "rejected": false,
  "summary": "2문장 이내 계획 요약 (한글만)",
  "days": [
    { "day": 1, "tasks": ["구체적 행동 (한글만)"] },
    { "day": 2, "tasks": ["구체적 행동 (한글만)"] },
    { "day": 3, "tasks": [] },
    { "day": 4, "tasks": ["구체적 행동 (한글만)"] }
  ]
}

[반려 응답 형식]
{ "rejected": true, "message": "친절한 안내 메시지 (한글만)" }`;

    const fewShot = [
      {
        role: 'user',
        content: '목표: 시험\n세부사항: 없음\n기간: 7일'
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          rejected: true,
          message: '어떤 시험인지 알려주시면 맞춤 계획을 만들어드릴 수 있어요. 예를 들어 "토익 800점", "한국사 1급", "정보처리기사" 처럼 구체적인 시험 이름을 입력해주세요!'
        })
      },
      {
        role: 'user',
        content: '목표: 토익 700점 달성\n세부사항: 듣기와 읽기 파트 모두 공부, 하루 1시간 가능\n기간: 5일'
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          rejected: false,
          summary: '5일 동안 토익 듣기와 읽기를 균형 있게 공부하는 계획입니다. 매일 1시간씩 집중해서 핵심 문제 유형을 익힙니다.',
          days: [
            { day: 1, tasks: ['토익 듣기 단답형 문제 20개 풀기'] },
            { day: 2, tasks: ['토익 읽기 빈칸 채우기 20문제 풀기'] },
            { day: 3, tasks: [] },
            { day: 4, tasks: ['토익 듣기 대화문 20개 풀기'] },
            { day: 5, tasks: ['이번 주 오답 정리 및 단어 복습'] }
          ]
        })
      },
      {
        role: 'user',
        content: '목표: 매일 3킬로미터 달리기\n세부사항: 현재 운동 전혀 안 함\n기간: 7일'
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          rejected: false,
          summary: '7일 동안 걷기부터 시작해 3킬로미터 달리기에 도전하는 점진적 훈련입니다.',
          days: [
            { day: 1, tasks: ['아침 걷기 20분'] },
            { day: 2, tasks: ['걷기 15분 후 달리기 5분'] },
            { day: 3, tasks: ['1킬로미터 완주 도전'] },
            { day: 4, tasks: ['걷기 10분 후 달리기 10분'] },
            { day: 5, tasks: ['달리기 15분 도전'] },
            { day: 6, tasks: ['스트레칭 10분 후 가벼운 걷기'] },
            { day: 7, tasks: ['3킬로미터 완주 도전'] }
          ]
        })
      }
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        ...fewShot,
        {
          role: 'user',
          content: `목표: ${goal}\n세부사항: ${detail || '없음'}\n기간: ${totalDays}일\n\n반드시 "days" 배열 구조로만 응답하세요. "weeks" 키는 절대 사용하지 마세요. day 값은 반드시 숫자(1~${totalDays})로 작성하세요. ${totalDays}일치 계획을 1일차부터 ${totalDays}일차까지 생성해줘. 모든 텍스트는 한글로만 작성하고 영어나 한자는 절대 사용하지 마세요.`
        }
      ],
      temperature: 0.25,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    });

    const text = completion.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 파싱 실패');

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.rejected) {
      // AI가 weeks 구조로 응답한 경우 days로 변환
      if (!Array.isArray(parsed.days) && Array.isArray(parsed.weeks)) {
        let dayNum = 1;
        const flatDays = [];
        for (const week of parsed.weeks) {
          for (const day of (week.days || [])) {
            flatDays.push({ day: dayNum++, tasks: Array.isArray(day.tasks) ? day.tasks : [] });
          }
        }
        parsed.days = flatDays;
        delete parsed.weeks;
      }

      if (!Array.isArray(parsed.days)) {
        return res.status(500).json({ error: 'AI 응답 구조가 올바르지 않아요. 다시 시도해주세요.' });
      }

      // days 개수가 totalDays보다 적으면 빈 일차로 채움
      while (parsed.days.length < totalDays) {
        parsed.days.push({ day: parsed.days.length + 1, tasks: [] });
      }

      // 일별 최대 2개 강제
      parsed.days.forEach(d => {
        if (Array.isArray(d.tasks) && d.tasks.length > 2) d.tasks = d.tasks.slice(0, 2);
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
// ── Storage 파일 삭제 ────────────────────────────────
app.delete('/files/delete', authMiddleware, async (req, res) => {
  const { urls } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls 배열이 필요합니다.' });
  }

  try {
    const BUCKET = 'task-files';

    // URL에서 Storage 경로 추출
    // 예: https://xxx.supabase.co/storage/v1/object/public/task-files/userId/taskId/file.jpg
    //     → userId/taskId/file.jpg
    const paths = urls.map(url => {
      const marker = '/' + BUCKET + '/';
      const idx = url.indexOf(marker);
      if (idx === -1) return null;
      return url.slice(idx + marker.length);
    }).filter(Boolean);

    if (paths.length === 0) {
      return res.status(400).json({ error: '유효한 파일 경로가 없습니다.' });
    }

    const { error } = await supabase.storage.from(BUCKET).remove(paths);

    if (error) {
      console.error('Storage 삭제 오류:', error);
      return res.status(500).json({ error: 'Storage 삭제 실패: ' + error.message });
    }

    console.log('✅ Storage 파일 삭제 완료:', paths);
    res.json({ ok: true, deleted: paths });
  } catch (err) {
    console.error('파일 삭제 에러:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`memota-back running on port ${PORT}`));

module.exports = app;
