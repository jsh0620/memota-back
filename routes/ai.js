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
      temperature: 0.4,
      max_tokens: 3000,
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

function safeParseJSON(text) {
  let cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1) {
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  }
  return JSON.parse(cleaned);
}

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

    const start = new Date(startDate || new Date());
    const weekRanges = [];
    for (let w = 0; w < durationNum; w++) {
      const weekStart = new Date(start);
      weekStart.setDate(start.getDate() + w * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      weekRanges.push(`${w+1}주차: ${weekStart.getMonth()+1}월 ${weekStart.getDate()}일 ~ ${weekEnd.getMonth()+1}월 ${weekEnd.getDate()}일`);
    }

    const systemPrompt = `당신은 개인 플래너 AI 어시스턴트입니다.

[절대 규칙 - 반드시 준수]
1. 모든 텍스트는 100% 순수 한국어(한글)로만 작성하세요.
2. 한자, 일본어, 영어, 중국어 등 외국어를 단 한 글자도 사용하지 마세요.
3. 숫자와 한글, 공백, 기본 문장부호(. , ! ?)만 사용 가능합니다.
4. 반드시 유효한 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요.
5. 목표가 너무 추상적이면 rejected: true를 반환하세요.
6. weeks 배열에 반드시 요청된 주차 수만큼 데이터를 포함하세요.
7. 각 주차의 days 배열에는 반드시 월,화,수,목,금,토,일 순서로 7개 요일 객체가 모두 있어야 합니다.
8. tasks가 없는 날도 빈 배열 []로 반드시 포함하세요.

[할 일 작성 핵심 원칙 - 매우 중요]
- 각 할 일은 구체적인 행동 동사 + 수량/시간/방법이 포함된 문장으로 작성하세요.
- 절대로 목표 문구 자체를 그대로 반복하지 마세요.
- 나쁜 예시: "독서하기", "운동하기", "공부하기" (이런 식으로 쓰면 절대 안 됨)
- 좋은 예시: "책 20페이지 읽기", "줄거리 노트에 정리하기", "오늘 읽은 내용 3줄 요약", "어제 읽은 부분 복습하기", "등장인물 특징 정리하기"
- 각 주차마다 난이도와 내용이 점진적으로 발전해야 합니다.
- 주차가 올라갈수록 더 심화된 활동을 포함하세요.
- 주말(토,일)에는 주중 활동의 복습이나 정리 활동을 넣거나 비워도 됩니다.
- 할 일 텍스트는 최대 20자 이내로 작성하세요.

[세부 사항 반영 원칙]
- 사용자가 입력한 세부 사항(시간대, 방식, 환경 등)을 각 할 일에 반드시 반영하세요.
- 예: "아침에 30분" -> "아침 독서 30분 완료", "평일 위주" -> 평일에 할 일 집중 배치

[응답 형식]
{
  "rejected": false,
  "weeks": [
    {
      "week": 1,
      "theme": "1주차 핵심 목표를 한 문장으로",
      "days": [
        { "day": "월", "tasks": ["구체적 행동 1", "구체적 행동 2"] },
        { "day": "화", "tasks": ["구체적 행동 1"] },
        { "day": "수", "tasks": ["구체적 행동 1"] },
        { "day": "목", "tasks": ["구체적 행동 1"] },
        { "day": "금", "tasks": ["구체적 행동 1"] },
        { "day": "토", "tasks": ["복습 또는 정리 활동"] },
        { "day": "일", "tasks": [] }
      ]
    }
  ]
}

[반려 형식]
{ "rejected": true, "message": "반려 이유를 한글로 설명" }`;

    const userPrompt = `목표: ${goal}
기간: ${durationNum}주
시작 날짜: ${startDate}
세부 사항: ${detail || '없음'}
주차별 날짜 범위:
${weekRanges.join('\n')}

[계획 생성 시 꼭 지켜야 할 사항]
1. "${goal}"이라는 목표를 달성하기 위해 매일 실행할 수 있는 아주 구체적인 행동 단계로 쪼개줘.
2. 세부 사항 "${detail || '없음'}"을 충분히 반영해서 현실적인 계획을 만들어줘.
3. 할 일 텍스트에 절대로 목표 키워드 자체(예: "독서하기", "운동하기")를 그대로 쓰지 말고, 반드시 구체적인 행동(예: "책 25페이지 읽기", "줄거리 노트 작성")으로 써줘.
4. ${durationNum}주에 걸쳐 점진적으로 발전하는 계획을 짜줘. 1주차는 기초, 마지막 주차는 심화 단계.
5. 반드시 ${durationNum}개의 week 객체를 만들고, 각 week마다 월화수목금토일 7개 day 객체를 포함해야 해.
6. 모든 텍스트는 순수 한국어로만 작성하고, 한자나 영어는 절대 사용하지 마.
7. JSON만 출력하고 다른 설명은 절대 추가하지 마.`;

    const raw = await callGroq(systemPrompt, userPrompt);
    const parsed = safeParseJSON(raw);

    if (!parsed.rejected && !validateWeeks(parsed.weeks, durationNum)) {
      console.warn('/ai/plan 구조 검증 실패, raw:', raw.substring(0, 300));
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

    const DAY_KR = ["일", "월", "화", "수", "목", "금", "토"];
    const dayStats = {};
    recentTasks.forEach(t => {
      const day = DAY_KR[new Date(t.date).getDay()];
      if (!dayStats[day]) dayStats[day] = { total: 0, done: 0 };
      dayStats[day].total++;
      if (t.completed) dayStats[day].done++;
    });

    const systemPrompt = `당신은 개인 생산성 코치 AI입니다.

[절대 규칙 - 반드시 준수]
1. 모든 텍스트는 100% 순수 한국어(한글)로만 작성하세요.
2. 한자, 일본어, 영어, 중국어 등 외국어를 단 한 글자도 사용하지 마세요.
3. 숫자와 한글, 공백, 기본 문장부호만 사용 가능합니다.
4. 반드시 유효한 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요.
5. 톤은 따뜻하고 격려하는 말투를 사용하세요.
6. nextWeekPlan의 days 배열에는 반드시 월,화,수,목,금,토,일 순서로 7개 요일 객체가 모두 있어야 합니다.
7. tasks가 없는 날도 빈 배열 []로 반드시 포함하세요.
8. insights는 2~3개의 한글 문장으로, 실질적인 분석 내용을 포함해야 합니다.

[추천 계획 작성 원칙]
- 분석 데이터에서 실제로 자주 등장한 할 일 유형을 파악해서 반영하세요.
- 완료율이 높은 요일에는 중요한 할 일을, 낮은 요일에는 가벼운 할 일을 배치하세요.
- 각 할 일은 구체적인 행동 동사 + 수량/방법이 포함된 문장으로 작성하세요.
- 절대로 추상적인 단어(예: "공부하기", "운동하기")만 단독으로 사용하지 마세요.

[응답 형식]
{
  "insights": ["구체적 인사이트 문장 1", "구체적 인사이트 문장 2", "다음 주 전략 제안"],
  "bestDay": "월요일",
  "weakDay": "금요일",
  "nextWeekPlan": {
    "theme": "다음 주 핵심 목표 한 문장",
    "days": [
      { "day": "월", "tasks": ["구체적 행동 1"] },
      { "day": "화", "tasks": ["구체적 행동 1"] },
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
- 요일별 통계: ${JSON.stringify(dayStats)}
- 최근 2주 할 일 목록: ${JSON.stringify(recentTasks.map(t=>({date:t.date,text:t.text,completed:t.completed})))}

위 데이터를 바탕으로:
1. 완료율이 높은 요일과 낮은 요일을 파악해서 구체적인 인사이트를 작성해줘.
2. 실제 할 일 패턴을 분석해서 다음 주 현실적인 계획을 추천해줘.
3. nextWeekPlan.days는 반드시 월화수목금토일 7개 객체를 포함해야 해.
4. 절대 한자나 외국어를 사용하지 말고, 100% 순수 한국어로만 답변해.
5. JSON만 출력하고 다른 설명은 절대 추가하지 마.`;

    const raw = await callGroq(systemPrompt, userPrompt);
    const parsed = safeParseJSON(raw);

    if (!parsed.nextWeekPlan || !Array.isArray(parsed.nextWeekPlan.days)) {
      console.warn('/ai/analyze 구조 검증 실패, raw:', raw.substring(0, 300));
      return res.status(500).json({ error: 'AI 응답 구조가 올바르지 않아요. 다시 시도해주세요.' });
    }

    return res.json({ ...parsed, rate });
  } catch (err) {
    console.error('/ai/analyze 오류:', err);
    return res.status(500).json({ error: 'AI 분석 중 오류: ' + err.message });
  }
});

module.exports = router;
