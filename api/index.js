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
// ── AI 하루형 플랜 ────────────────────────────────────
app.post('/ai/day-plan', authMiddleware, async (req, res) => {
  const { wakeTime, sleepTime, goals, timeWeights } = req.body;
  if (!goals || !goals.trim()) return res.status(400).json({ error: '오늘 할 일을 입력해주세요.' });

  try {
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // 가중치 → 한글 설명으로 변환
    const weightDesc = Object.entries(timeWeights || {})
      .map(([slot, w]) => `${slot}(${w})`)
      .join(', ');

    const systemPrompt = `당신은 하루 일과 전체를 설계하는 전문 플래너입니다.

[절대 규칙]
1. 모든 텍스트는 100% 한국어(한글)로만 작성합니다. 영어·한자 사용 절대 금지.
2. 반드시 유효한 JSON만 응답합니다. 코드블록·설명 없이 JSON만.
3. 응답 최상위 키: "rejected", "tasks" 두 가지만.
4. tasks 배열 각 원소: { "timeSlot": "오전|점심|오후|밤|새벽", "time": "HH:MM", "text": "구체적 행동" }
5. time은 24시간제 HH:MM 형식 (예: 07:30, 14:00).
6. 기상~취침 시간 범위 내에서만 일정을 배치합니다.
7. 가중치가 "높음"인 시간대에는 중요도 높은 핵심 작업을 배치합니다.
8. 가중치가 "낮음"인 시간대에는 가벼운 작업이나 휴식을 배치합니다.
9. 가중치가 "없음"인 시간대는 일정을 배치하지 않습니다.
10. 식사(아침/점심/저녁), 이동, 휴식 등 기본 생활 일과도 포함하세요.
11. 각 항목은 15~30분 단위로 구체적으로 작성합니다.

[반려 기준 - rejected: true]
- 입력 내용이 너무 짧거나 의미 불명확한 경우

[정상 응답 형식]
{ "rejected": false, "tasks": [ { "timeSlot": "오전", "time": "07:00", "text": "기상 및 스트레칭 10분" }, ... ] }

[반려 형식]
{ "rejected": true, "message": "안내 메시지" }`;

    const userContent = `기상: ${wakeTime || '07:00'}, 취침: ${sleepTime || '23:00'}
시간대 가중치: ${weightDesc}
오늘 해야 할 일: ${goals}

위 조건에 맞게 기상부터 취침까지 하루 전체 일과를 세세하게 계획해줘. 반드시 JSON만 응답.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    });

    const text = completion.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 파싱 실패');
    const parsed = JSON.parse(jsonMatch[0]);

    // tasks 시간 오름차순 정렬
    if (!parsed.rejected && Array.isArray(parsed.tasks)) {
      parsed.tasks.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: 'AI 오류: ' + err.message });
  }
});

// ── AI 계획형 플랜 ────────────────────────────────────
app.post('/ai/goal-plan', authMiddleware, async (req, res) => {
  const { goal, detail, dates, dayWeights } = req.body;

  if (!goal || !goal.trim()) return res.status(400).json({ error: '목표를 입력해주세요.' });
  if (!dates || !Array.isArray(dates) || dates.length === 0)
    return res.status(400).json({ error: '날짜를 선택해주세요.' });
  if (dates.length > 60) return res.status(400).json({ error: '날짜를 60일 이내로 선택해주세요.' });

  try {
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const DAY_KR = ['일', '월', '화', '수', '목', '금', '토'];
    // 날짜별 요일 + 가중치 목록
    const dateInfo = dates.map(d => {
      const dayLabel = DAY_KR[new Date(d + 'T00:00:00').getDay()];
      const weight = (dayWeights && dayWeights[dayLabel]) || '중간';
      return `${d}(${dayLabel}, 가중치:${weight})`;
    }).join(', ');

    const systemPrompt = `당신은 목표 달성을 위한 구체적 실천 계획을 설계하는 전문 코치입니다.

[절대 규칙]
1. 모든 텍스트는 100% 한국어(한글)로만 작성합니다. 영어·한자 사용 절대 금지.
2. 반드시 유효한 JSON만 응답합니다. 코드블록·설명 없이 JSON만.
3. 응답 최상위 키: "rejected", "tasks" 두 가지만.
4. tasks 배열 각 원소: { "date": "YYYY-MM-DD", "time": "HH:MM 또는 빈 문자열", "text": "구체적 행동" }
5. 반드시 입력받은 날짜 목록 안의 날짜만 사용합니다. 목록에 없는 날짜는 절대 사용 금지.
6. 가중치가 "높음"인 날짜에는 중요하고 집중도 높은 작업을 배치합니다.
7. 가중치가 "낮음"인 날짜에는 가벼운 복습·정리 작업을 배치합니다.
8. 날짜별 할 일은 1~3개로 제한합니다.
9. 각 할 일은 구체적 행동으로 작성합니다 (나쁜 예: "공부" / 좋은 예: "단어 30개 암기 후 예문 3개 작성").
10. 전체 날짜에 걸쳐 목표 달성을 위한 자연스러운 점진적 흐름(초반→중반→마무리)을 만드세요.

[반려 기준 - rejected: true]
- 목표가 너무 짧거나 의미 불명확한 경우
- 비윤리적·폭력적 내용

[정상 응답 형식]
{ "rejected": false, "tasks": [ { "date": "2025-07-10", "time": "09:00", "text": "구체적 행동" }, ... ] }

[반려 형식]
{ "rejected": true, "message": "안내 메시지" }`;

    const userContent = `목표: ${goal}
세부사항: ${detail || '없음'}
계획 날짜 (날짜, 요일, 가중치): ${dateInfo}

위 날짜만 사용해서 목표 달성을 위한 구체적 계획을 작성해줘. 반드시 JSON만 응답.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.25,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    });

    const text = completion.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 파싱 실패');
    const parsed = JSON.parse(jsonMatch[0]);

    // 허용된 날짜 외 필터링 + 날짜 오름차순 정렬
    if (!parsed.rejected && Array.isArray(parsed.tasks)) {
      const allowedSet = new Set(dates);
      parsed.tasks = parsed.tasks
        .filter(t => t.date && allowedSet.has(t.date))
        .sort((a, b) => {
          if (a.date !== b.date) return a.date.localeCompare(b.date);
          return (a.time || '').localeCompare(b.time || '');
        });
    }

    res.json(parsed);
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
