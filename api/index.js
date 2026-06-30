// index.js (경로: memota-back/api/index.js)
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' })); // ← 파일 데이터를 위해 limit 증가

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const JWT_SECRET = process.env.JWT_SECRET || 'memota-secret-key';

// ── AWS S3 클라이언트 설정 ──────────────────────────
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const S3_BUCKET = process.env.AWS_S3_BUCKET;

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'memota-back running' });
});

app.post('/auth/register', async (req, res) => {
  const { username, password, securityQuestion, securityAnswer } = req.body;

  if (!username || username.length < 3)
    return res.status(400).json({ error: '아이디는 3자 이상이어야 합니다.' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  if (!securityQuestion || securityQuestion.trim().length < 2)
    return res.status(400).json({ error: '비밀번호 찾기 질문을 입력해주세요.' });
  if (!securityAnswer || securityAnswer.trim().length < 1)
    return res.status(400).json({ error: '비밀번호 찾기 답변을 입력해주세요.' });

  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', username)
    .single();

  if (existing)
    return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });

  const hashedPassword = await bcrypt.hash(password, 10);
  // ✅ 답변은 대소문자/공백 차이로 인한 불일치를 막기 위해 정규화 후 해시 저장
  const normalizedAnswer = securityAnswer.trim().toLowerCase();
  const hashedAnswer = await bcrypt.hash(normalizedAnswer, 10);

  const { data, error } = await supabase
    .from('profiles')
    .insert([{
      username,
      password: hashedPassword,
      security_question: securityQuestion.trim(),
      security_answer: hashedAnswer,
    }])
    .select()
    .single();

  if (error)
    return res.status(500).json({ error: '회원가입 실패: ' + error.message });

  const token = jwt.sign({ userId: data.id, username }, JWT_SECRET, {
    expiresIn: '30d',
  });

  res.json({ token, user: { id: data.id, username } });
});

// ── 비밀번호 재설정 1단계: 아이디로 보안질문 조회 ──────
app.post('/auth/find-question', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: '아이디를 입력해주세요.' });

  const { data: user } = await supabase
    .from('profiles')
    .select('security_question')
    .eq('username', username)
    .single();

  // ⚠️ 존재 여부를 굳이 구분해서 알려주지 않음 (아이디 존재 여부 추측 방지)
  if (!user || !user.security_question)
    return res.status(404).json({ error: '아이디 또는 등록된 보안질문 정보를 찾을 수 없습니다.' });

  res.json({ question: user.security_question });
});

// ── 비밀번호 재설정 2단계: 답변만 먼저 검증 (비밀번호 입력 전) ──
app.post('/auth/verify-answer', async (req, res) => {
  const { username, securityAnswer } = req.body;

  if (!username || !securityAnswer)
    return res.status(400).json({ error: '필요한 정보가 모두 입력되지 않았습니다.' });

  const { data: user } = await supabase
    .from('profiles')
    .select('id, security_answer')
    .eq('username', username)
    .single();

  if (!user || !user.security_answer)
    return res.status(404).json({ error: '아이디 또는 보안질문 정보를 찾을 수 없습니다.' });

  const normalizedAnswer = securityAnswer.trim().toLowerCase();
  const isValid = await bcrypt.compare(normalizedAnswer, user.security_answer);
  if (!isValid)
    return res.status(401).json({ error: '답변이 일치하지 않습니다.' });

  res.json({ ok: true });
});

// ── 비밀번호 재설정 3단계: 답변 재검증 후 새 비밀번호로 변경 ──
app.post('/auth/reset-password', async (req, res) => {
  const { username, securityAnswer, newPassword } = req.body;

  if (!username || !securityAnswer || !newPassword)
    return res.status(400).json({ error: '필요한 정보가 모두 입력되지 않았습니다.' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });

  const { data: user } = await supabase
    .from('profiles')
    .select('id, security_answer')
    .eq('username', username)
    .single();

  if (!user || !user.security_answer)
    return res.status(404).json({ error: '아이디 또는 보안질문 정보를 찾을 수 없습니다.' });

  const normalizedAnswer = securityAnswer.trim().toLowerCase();
  const isValid = await bcrypt.compare(normalizedAnswer, user.security_answer);
  if (!isValid)
    return res.status(401).json({ error: '답변이 일치하지 않습니다.' });

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  const { error: updateError } = await supabase
    .from('profiles')
    .update({ password: hashedPassword })
    .eq('id', user.id);

  if (updateError)
    return res.status(500).json({ error: '비밀번호 변경 실패: ' + updateError.message });

  res.json({ ok: true });
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

// ── 회원탈퇴: S3 파일 전부 + DB 데이터(tasks, date_emojis, profiles) 전부 삭제 ──
app.delete('/auth/withdraw', authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const { password } = req.body;

  if (!password)
    return res.status(400).json({ error: '비밀번호를 입력해주세요.' });

  try {
    // 0. 본인 확인: 현재 로그인 비밀번호 검증
    const { data: profile } = await supabase
      .from('profiles')
      .select('password')
      .eq('id', userId)
      .single();

    if (!profile)
      return res.status(404).json({ error: '계정 정보를 찾을 수 없습니다.' });

    const isValid = await bcrypt.compare(password, profile.password);
    if (!isValid)
      return res.status(401).json({ error: '비밀번호가 일치하지 않습니다.' });

    // 1. S3에서 해당 유저 폴더(userId/...) 안의 모든 파일 목록 조회 후 전부 삭제
    let continuationToken = undefined;
    const allKeys = [];
    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: `${userId}/`,
        ContinuationToken: continuationToken,
      });
      const listResult = await s3.send(listCommand);
      (listResult.Contents || []).forEach(obj => allKeys.push(obj.Key));
      continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
    } while (continuationToken);

    if (allKeys.length > 0) {
      // DeleteObjectsCommand는 한 번에 최대 1000개까지 가능 → 1000개씩 나눠서 삭제
      for (let i = 0; i < allKeys.length; i += 1000) {
        const chunk = allKeys.slice(i, i + 1000);
        await s3.send(new DeleteObjectsCommand({
          Bucket: S3_BUCKET,
          Delete: { Objects: chunk.map(key => ({ Key: key })) },
        }));
      }
    }

    // 2. date_emojis 삭제
    const { error: emojiError } = await supabase
      .from('date_emojis')
      .delete()
      .eq('user_id', userId);
    if (emojiError) throw emojiError;

    // 3. tasks 삭제
    const { error: tasksError } = await supabase
      .from('tasks')
      .delete()
      .eq('user_id', userId);
    if (tasksError) throw tasksError;

    // 4. archives 삭제 (있을 경우)
    await supabase.from('archives').delete().eq('user_id', userId);

    // 5. profiles 삭제 (아이디/비밀번호 포함 계정 정보 완전 삭제)
    const { error: profileError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', userId);
    if (profileError) throw profileError;

    console.log(`✅ 회원탈퇴 완료 (userId: ${userId}, 삭제된 S3 파일: ${allKeys.length}개)`);
    res.json({ ok: true });
  } catch (err) {
    console.error('회원탈퇴 처리 실패:', err.message);
    res.status(500).json({ error: '회원탈퇴 처리 중 오류가 발생했습니다: ' + err.message });
  }
});

// ── [S3] presigned URL에서 key(경로) 추출 ───────────
// 예: https://memota-files.s3.ap-northeast-2.amazonaws.com/userId/taskId/file.jpg?X-Amz-...
//     → userId/taskId/file.jpg
// ⚠️ 저장된 url이 오래돼서 만료됐어도, 경로(key) 부분은 절대 안 바뀌므로 항상 추출 가능함
function extractS3KeyFromUrl(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

// ── [S3] tasks 배열 안의 모든 첨부파일 url을 "방금 발급한 새 URL"로 교체 ──
// DB에는 예전에 저장된(만료됐을 수도 있는) url이 들어있지만,
// 할 일을 "불러올 때마다" 항상 새로 1시간짜리 URL로 갈아끼워서 보내줌
// → 프론트엔드는 url 만료를 전혀 신경 쓸 필요가 없어짐
async function refreshFileUrls(tasks) {
  const keySet = new Set();
  tasks.forEach(t => {
    (t.files || []).forEach(f => {
      const key = extractS3KeyFromUrl(f.url);
      if (key) keySet.add(key);
    });
  });

  if (keySet.size === 0) return tasks;

  const keys = Array.from(keySet);
  const urlMap = {};

  await Promise.all(keys.map(async (key) => {
    try {
      const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
      const url = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1시간
      urlMap[key] = url;
    } catch (e) {
      console.error('파일 URL 갱신 실패 (무시하고 계속):', key, e.message);
    }
  }));

  return tasks.map(t => {
    if (!t.files || t.files.length === 0) return t;
    return {
      ...t,
      files: t.files.map(f => {
        const key = extractS3KeyFromUrl(f.url);
        const freshUrl = key && urlMap[key] ? urlMap[key] : f.url;
        return { ...f, url: freshUrl };
      }),
    };
  });
}

// ── 할 일 조회 ──────────────────────────────────────
app.get('/tasks/:userId', authMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId);

  if (error) return res.status(500).json({ error: error.message });
  
  // ✅ DB → 프론트엔드 필드명 변환
  let tasks = (data || []).map(row => ({
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

  // ✅ 첨부파일이 있으면 항상 새 presigned URL로 갈아끼워서 응답
  tasks = await refreshFileUrls(tasks);
  
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

// ── [S3] 업로드용 Presigned URL 발급 ────────────────
// 프론트가 이 URL을 받아서 S3에 "직접" 파일을 PUT 업로드함 (백엔드를 경유하지 않음)
app.post('/files/upload-url', authMiddleware, async (req, res) => {
  const { taskId, fileName, contentType } = req.body;
  const userId = req.user.userId;

  if (!taskId || !fileName) {
    return res.status(400).json({ error: 'taskId, fileName이 필요합니다.' });
  }

  try {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const safeFileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext ? '.' + ext : ''}`;
    const key = `${userId}/${taskId}/${safeFileName}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: contentType || 'application/octet-stream',
    });

    // 5분 동안만 유효한 업로드 주소 (업로드는 보통 금방 끝나므로 짧게 설정)
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    res.json({ uploadUrl, key });
  } catch (err) {
    console.error('업로드 URL 발급 실패:', err);
    res.status(500).json({ error: '업로드 URL 발급 실패: ' + err.message });
  }
});

// ── [S3] 조회/다운로드용 Presigned URL 발급 ─────────
// key 배열을 받아서, 각각에 대해 "1시간 동안 열람 가능한" 임시 URL을 발급
app.post('/files/get-url', authMiddleware, async (req, res) => {
  const { keys } = req.body;

  if (!keys || !Array.isArray(keys) || keys.length === 0) {
    return res.status(400).json({ error: 'keys 배열이 필요합니다.' });
  }

  try {
    const results = await Promise.all(
      keys.map(async (key) => {
        const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
        const url = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1시간
        return { key, url };
      })
    );

    res.json({ urls: results });
  } catch (err) {
    console.error('조회 URL 발급 실패:', err);
    res.status(500).json({ error: '조회 URL 발급 실패: ' + err.message });
  }
});

// ── [S3] 파일 삭제 ───────────────────────────────────
app.delete('/files/delete', authMiddleware, async (req, res) => {
  const { keys } = req.body;

  if (!keys || !Array.isArray(keys) || keys.length === 0) {
    return res.status(400).json({ error: 'keys 배열이 필요합니다.' });
  }

  try {
    const command = new DeleteObjectsCommand({
      Bucket: S3_BUCKET,
      Delete: {
        Objects: keys.map(key => ({ Key: key })),
      },
    });

    const result = await s3.send(command);

    console.log('✅ S3 파일 삭제 완료:', keys);
    res.json({ ok: true, deleted: keys, errors: result.Errors || [] });
  } catch (err) {
    console.error('S3 파일 삭제 에러:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`memota-back running on port ${PORT}`));

module.exports = app;
