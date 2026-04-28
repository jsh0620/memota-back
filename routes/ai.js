// ai.js (경로: memota-back/routes/ai.js)
const express = require('express');
const router = express.Router();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

async function callGroq(systemPrompt, userPrompt) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.3,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
    }),
  });
  if (!response.ok) { const err = await response.text(); throw new Error(`Groq API 오류: ${err}`); }
  const data = await response.json();
  return data.choices[0].message.content;
}

// ✅ Fix 4: JSON 파싱 강화 - 마크다운 코드블록 제거 후 파싱
function safeParseJSON(text) {
  // ```json ... ``` 또는 ``` ... ``` 형태 제거
  let cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // JSON 시작 위치를 찾아 앞뒤 불필요한 텍스트 제거
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1) {
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  }

  return JSON.parse(cleaned);
}

// ✅ Fix 4: weeks 배열 구조 검증 함수
function validateWeeks(weeks, duration) {
  if (!Array.isArray(weeks)) return false;
  if (weeks.length !== duration) return false;
  for (const week of weeks) {
    if (!week.week || !Array.isArray(week.days)) return false;
    if (week.days.length !== 7) return false;
    for (const day of week.days) {
      if (!day.day || !Array.isArray(day.tasks)) return false;
    }
  }
  return true;
}

// POST /ai/plan
router.post('/plan', async (req, res) => {
  try {
    const { goal, duration, detail, startDate } = req.body;
    if (!goal || !duration) return res.status(400).json({ error: '목표와 기간은 필수입니다.' });

    const durationNum = parseInt(duration, 10);

    // 주차별 날짜 범위 계산
    const start = new Date(startDate || new Date());
    const weekRanges = [];
    for (let w = 0; w < durationNum; w++) {
      const weekStart = new Date(start);
      weekStart.setDate(start.getDate() + w * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      weekRanges.push(`${w+1}주차: ${weekStart.getMonth()+1}월 ${weekStart.getDate()}일 ~ ${weekEnd.getMonth()+1}월 ${weekEnd.getDate()}일`);
    }

    // ✅ Fix 4: 구조가 정확히 일치하도록 프롬프트 강화
    const systemPrompt = `당신은 개인 플래너 AI 어시스턴트입니다.

[절대 규칙 - 반드시 준수]
1. 모든 텍스트는 100% 순수 한국어(한글)로만 작성하세요.
2. 한자, 일본어, 영어, 중국어 등 외국어를 단 한 글자도 사용하지 마세요.
3. 숫자와 한글만 사용 가능합니다.
4. 반드시 유효한 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요.
5. 각 할 일은 15자 이내의 명확한 한글 문장으로 작성하세요.
6. 목표가 너무 추상적이면 rejected: true를 반환하세요.
7. weeks 배열에 반드시 요청된 주차 수만큼 데이터를 포함하세요.
8. 각 주차의 days 배열에는 반드시 월,화,수,목,금,토,일 순서로 7개 요일 객체가 모두 있어야 합니다.
9. tasks가 없는 날도 빈 배열 []로 반드시 포함하세요.

[응답 형식 - 이 구조를 정확히 따르세요]
{
  "rejected": false,
  "weeks": [
    {
      "week": 1,
      "theme": "첫 주 목표",
      "days": [
        { "day": "월", "tasks": ["할 일 1", "할 일 2"] },
        { "day": "화", "tasks": ["할 일 1"] },
        { "day": "수", "tasks": ["할 일 1"] },
        { "day": "목", "tasks": ["할 일 1"] },
        { "day": "금", "tasks": ["할 일 1"] },
        { "day": "토", "tasks": [] },
        { "day": "일", "tasks": [] }
      ]
    }
  ]
}

[반려 형식]
{ "rejected": true, "message": "목표가 너무 추상적인 이유 설명" }`;

    const userPrompt = `목표: ${goal}
기간: ${durationNum}주
시작 날짜: ${startDate}
세부 사항: ${detail || '없음'}
주차별 날짜 범위:
${weekRanges.join('\n')}

위 정보를 바탕으로 ${durationNum}주 계획을 생성해줘.
반드시 ${durationNum}개의 week 객체를 만들고, 각 week마다 월화수목금토일 7개 day 객체를 포함해야 해.
모든 텍스트는 순수 한국어(한글)로만 작성하고, 한자나 영어는 절대 사용하지 마.
JSON만 출력하고 다른 설명은 절대 추가하지 마.`;

    const raw = await callGroq(systemPrompt, userPrompt);
    const parsed = safeParseJSON(raw);

    // ✅ Fix 4: 응답 구조 검증
    if (!parsed.rejected && !validateWeeks(parsed.weeks, durationNum)) {
      console.warn('/ai/plan 구조 검증 실패, raw:', raw.substring(0, 200));
      return res.status(500).json({ error: 'AI 응답 구조가 올바르지 않아요. 다시 시도해주세요.' });
    }

    return res.json(parsed);
  } catch (err) {
    console.error('/ai/plan 오류:', err);
    return res.status(500).json({ error: 'AI 계획 생성 중 오류: ' + err.message });
  }
});

// POST /ai/analyze
router.post('/analyze', async (req, res) => {
  try {
    const { tasks } = req.body;
    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: '분석할 데이터가 없습니다.' });
    }

    const now = new Date();
    const twoWeeksAgo = new Date(now); twoWeeksAgo.setDate(now.getDate()-14);
    const recentTasks = tasks.filter(t => { const d=new Date(t.date); return d>=twoWeeksAgo && d<=now; });
    if (recentTasks.length === 0) return res.status(400).json({ error: '최근 2주 데이터가 없습니다.' });

    const total = recentTasks.length;
    const done  = recentTasks.filter(t=>t.completed).length;
    const rate  = Math.round((done/total)*100);

    // ✅ Fix 4: nextWeekPlan days 구조를 프론트의 normalizeDays와 정확히 일치하도록 강화
    const systemPrompt = `당신은 개인 생산성 코치 AI입니다.

[절대 규칙 - 반드시 준수]
1. 모든 텍스트는 100% 순수 한국어(한글)로만 작성하세요.
2. 한자, 일본어, 영어, 중국어 등 외국어를 단 한 글자도 사용하지 마세요.
3. 숫자와 한글만 사용 가능합니다.
4. 반드시 유효한 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요.
5. 톤은 따뜻하고 격려하는 말투를 사용하세요.
6. nextWeekPlan의 days 배열에는 반드시 월,화,수,목,금,토,일 순서로 7개 요일 객체가 모두 있어야 합니다.
7. tasks가 없는 날도 빈 배열 []로 반드시 포함하세요.
8. insights는 2~3개의 한글 문장으로 작성하세요.

[응답 형식 - 이 구조를 정확히 따르세요]
{
  "insights": ["인사이트 문장 1", "인사이트 문장 2"],
  "bestDay": "월요일",
  "weakDay": "금요일",
  "nextWeekPlan": {
    "theme": "다음 주 목표 테마",
    "days": [
      { "day": "월", "tasks": ["할 일 1"] },
      { "day": "화", "tasks": ["할 일 1"] },
      { "day": "수", "tasks": [] },
      { "day": "목", "tasks": [] },
      { "day": "금", "tasks": [] },
      { "day": "토", "tasks": [] },
      { "day": "일", "tasks": [] }
    ]
  }
}`;

    const userPrompt = `분석 데이터:
- 전체 달성률: ${rate}% (총 ${total}개 중 ${done}개 완료)
- 최근 2주 할 일: ${JSON.stringify(recentTasks.map(t=>({date:t.date,text:t.text,completed:t.completed})))}

위 데이터를 바탕으로 인사이트와 다음 주 추천 계획을 작성해줘.
nextWeekPlan.days는 반드시 월화수목금토일 7개 객체를 포함해야 해.
절대 한자나 외국어를 사용하지 말고, 100% 순수 한국어로만 답변해.
JSON만 출력하고 다른 설명은 절대 추가하지 마.`;

    const raw = await callGroq(systemPrompt, userPrompt);
    const parsed = safeParseJSON(raw);

    // ✅ Fix 4: nextWeekPlan 구조 검증
    if (!parsed.nextWeekPlan || !Array.isArray(parsed.nextWeekPlan.days)) {
      console.warn('/ai/analyze 구조 검증 실패, raw:', raw.substring(0, 200));
      return res.status(500).json({ error: 'AI 응답 구조가 올바르지 않아요. 다시 시도해주세요.' });
    }

    return res.json({ ...parsed, rate });
  } catch (err) {
    console.error('/ai/analyze 오류:', err);
    return res.status(500).json({ error: 'AI 분석 중 오류: ' + err.message });
  }
});

module.exports = router;
