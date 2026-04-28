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
      model: GROQ_MODEL, temperature: 0.3, max_tokens: 2048,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    }),
  });
  if (!response.ok) { const err = await response.text(); throw new Error(`Groq API 오류: ${err}`); }
  const data = await response.json();
  return data.choices[0].message.content;
}

function safeParseJSON(text) {
  const cleaned = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
  return JSON.parse(cleaned);
}

// POST /ai/plan
router.post('/plan', async (req, res) => {
  try {
    const { goal, duration, detail, startDate } = req.body;
    if (!goal || !duration) return res.status(400).json({ error: '목표와 기간은 필수입니다.' });

    // 주차별 날짜 범위 계산
    const start = new Date(startDate || new Date());
    const weekRanges = [];
    for (let w = 0; w < duration; w++) {
      const weekStart = new Date(start);
      weekStart.setDate(start.getDate() + w * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      weekRanges.push(`${w+1}주차: ${weekStart.getMonth()+1}월 ${weekStart.getDate()}일(월) ~ ${weekEnd.getMonth()+1}월 ${weekEnd.getDate()}일(일)`);
    }

    const systemPrompt = `당신은 개인 플래너 AI 어시스턴트입니다.

[절대 규칙]
- 모든 텍스트는 100% 순수 한국어(한글)로만 작성하세요.
- 한자, 일본어, 영어, 중국어 등 외국어를 단 한 글자도 사용하지 마세요.
- 숫자와 한글만 사용 가능합니다.
- 반드시 유효한 JSON 형식으로만 응답하세요.
- 각 할 일은 15자 이내의 명확한 한글 문장으로 작성하세요.
- 목표가 너무 추상적이면 rejected: true를 반환하세요.
- weeks 배열에 반드시 ${duration}개의 주차 데이터를 모두 포함하세요.
- 각 주차의 days 배열에는 반드시 월,화,수,목,금,토,일 7개 요일이 모두 포함되어야 합니다.

응답 형식 (JSON):
{
  "rejected": false,
  "weeks": [
    {
      "week": 1,
      "theme": "이번 주 목표를 한글로",
      "days": [
        { "day": "월", "tasks": ["한글 할 일 1", "한글 할 일 2"] },
        { "day": "화", "tasks": ["한글 할 일 1"] },
        { "day": "수", "tasks": ["한글 할 일 1"] },
        { "day": "목", "tasks": ["한글 할 일 1"] },
        { "day": "금", "tasks": ["한글 할 일 1"] },
        { "day": "토", "tasks": [] },
        { "day": "일", "tasks": [] }
      ]
    }
  ]
}`;

    const userPrompt = `목표: ${goal}
기간: ${duration}주
시작 날짜: ${startDate}
세부 사항: ${detail || '없음'}
주차별 날짜:
${weekRanges.join('\n')}

반드시 ${duration}주차 데이터를 모두 생성해줘.
모든 텍스트는 순수 한국어(한글)로만 작성하고, 한자나 외국어는 절대 사용하지 마.
JSON 형식으로만 답변해.`;

    const raw = await callGroq(systemPrompt, userPrompt);
    const parsed = safeParseJSON(raw);
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
    if (!tasks || tasks.length === 0) return res.status(400).json({ error: '분석할 데이터가 없습니다.' });

    const now = new Date();
    const twoWeeksAgo = new Date(now); twoWeeksAgo.setDate(now.getDate()-14);
    const recentTasks = tasks.filter(t => { const d=new Date(t.date); return d>=twoWeeksAgo && d<=now; });
    if (recentTasks.length === 0) return res.status(400).json({ error: '최근 2주 데이터가 없습니다.' });

    const total = recentTasks.length;
    const done  = recentTasks.filter(t=>t.completed).length;
    const rate  = Math.round((done/total)*100);

    const systemPrompt = `당신은 개인 생산성 코치 AI입니다.

[절대 규칙]
- 모든 텍스트는 100% 순수 한국어(한글)로만 작성하세요.
- 한자, 일본어, 영어, 중국어 등 외국어를 단 한 글자도 사용하지 마세요.
- 숫자와 한글만 사용 가능합니다.
- 반드시 유효한 JSON 형식으로만 응답하세요.
- 톤은 따뜻하고 격려하는 말투를 사용하세요.
- nextWeekPlan의 days 배열에는 반드시 월,화,수,목,금,토,일 7개 요일이 모두 포함되어야 합니다.

응답 형식 (JSON):
{
  "insights": ["인사이트 한글 문장 1", "인사이트 한글 문장 2"],
  "bestDay": "월요일",
  "weakDay": "금요일",
  "nextWeekPlan": {
    "theme": "다음 주 한글 테마",
    "days": [
      { "day": "월", "tasks": ["한글 할 일"] },
      { "day": "화", "tasks": ["한글 할 일"] },
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
- 최근 2주 할 일: ${JSON.stringify(recentTasks.map(t=>({date:t.date,text:t.text,completed:t.completed,category:t.category})))}

위 데이터를 바탕으로 인사이트와 다음 주 추천 계획을 작성해줘.
절대 한자나 외국어를 사용하지 말고, 100% 순수 한국어로만 답변해.
JSON 형식으로만 답변해.`;

    const raw = await callGroq(systemPrompt, userPrompt);
    const parsed = safeParseJSON(raw);
    return res.json({ ...parsed, rate });
  } catch (err) {
    console.error('/ai/analyze 오류:', err);
    return res.status(500).json({ error: 'AI 분석 중 오류: ' + err.message });
  }
});

module.exports = router;
