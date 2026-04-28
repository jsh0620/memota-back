// ai.js (경로: memota-back/routes/ai.js)

const express = require('express');
const router = express.Router();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ── Groq 호출 공통 함수 ──────────────────────────────
async function callGroq(systemPrompt, userPrompt) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.5, // 창의성보다는 정확도를 위해 온도를 낮춤
      max_tokens: 2048,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API 오류: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ── JSON 안전 파싱 ──────────────────────────────────
function safeParseJSON(text) {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

// ────────────────────────────────────────────────────
// POST /ai/plan  — 목표 기반 계획 생성
// ────────────────────────────────────────────────────
router.post('/plan', async (req, res) => {
  try {
    const { goal, duration, detail } = req.body;

    if (!goal || !duration) {
      return res.status(400).json({ error: '목표와 기간은 필수입니다.' });
    }

    const systemPrompt = `당신은 개인 플래너 AI 어시스턴트입니다.
반드시 다음 규칙을 엄격히 준수하세요:

1. 언어 제한: 모든 텍스트는 오직 '한국어'로만 작성하세요. 한자(漢字)나 다른 외국어 단어를 절대 사용하지 마세요. (예: 最近 -> 최근, 2週 -> 2주)
2. 형식: 반드시 유효한 JSON 형식으로만 응답하세요. 다른 설명 텍스트는 절대 포함하지 마세요.
3. 간결성: 각 할 일은 15자 이내의 명확한 한글 문장으로 작성하세요.
4. 목표 검증: 목표가 너무 추상적이면 rejected: true를 반환하세요.

응답 형식 (JSON):
{
  "rejected": false,
  "weeks": [
    {
      "week": 1,
      "theme": "한글로 된 이번 주 목표",
      "days": [
        { "day": "월", "tasks": ["한글 할 일 1", "한글 할 일 2"] }
      ]
    }
  ]
}`;

    const userPrompt = `목표: ${goal}
기간: ${duration}주
${detail ? `세부 사항: ${detail}` : ''}

위 목표에 맞는 계획을 생성해줘. 절대 한자를 섞지 말고 순수 한국어로만 답변해.`;

    const raw = await callGroq(systemPrompt, userPrompt);
    const parsed = safeParseJSON(raw);

    return res.json(parsed);
  } catch (err) {
    console.error('/ai/plan 오류:', err);
    return res.status(500).json({ error: 'AI 계획 생성 중 오류가 발생했습니다.' });
  }
});

// ────────────────────────────────────────────────────
// POST /ai/analyze  — 최근 2주 데이터 분석 + 다음 주 추천
// ────────────────────────────────────────────────────
router.post('/analyze', async (req, res) => {
  try {
    const { tasks } = req.body;

    if (!tasks || tasks.length === 0) {
      return res.status(400).json({ error: '분석할 데이터가 없습니다.' });
    }

    const now = new Date();
    const twoWeeksAgo = new Date(now);
    twoWeeksAgo.setDate(now.getDate() - 14);

    const recentTasks = tasks.filter(t => {
      const d = new Date(t.date);
      return d >= twoWeeksAgo && d <= now;
    });

    if (recentTasks.length === 0) {
      return res.status(400).json({ error: '최근 2주 데이터가 없습니다.' });
    }

    const total = recentTasks.length;
    const done = recentTasks.filter(t => t.completed).length;
    const rate = Math.round((done / total) * 100);

    const dayStats = {};
    const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
    recentTasks.forEach(t => {
      const day = DAY_NAMES[new Date(t.date).getDay()];
      if (!dayStats[day]) dayStats[day] = { total: 0, done: 0 };
      dayStats[day].total++;
      if (t.completed) dayStats[day].done++;
    });

    const catStats = {};
    recentTasks.forEach(t => {
      const cat = t.category || '기타';
      if (!catStats[cat]) catStats[cat] = { total: 0, done: 0 };
      catStats[cat].total++;
      if (t.completed) catStats[cat].done++;
    });

    const systemPrompt = `당신은 개인 생산성 코치 AI입니다. 사용자의 데이터를 분석하여 인사이트를 제공합니다.

반드시 다음 규칙을 엄격히 준수하세요:
1. 언어: 모든 답변은 반드시 '한국어(한글)'로만 작성하세요. '最近', '結果'와 같은 한자나 외국어를 절대 섞지 마세요. 100% 자연스러운 한국어 구어체로 작성하세요.
2. 톤: 따뜻하고 격려하는 말투를 사용하세요.
3. 형식: 유효한 JSON 형식으로만 응답하세요. 다른 텍스트는 일체 금지입니다.
4. 인사이트: 분석 결과에 기반하여 3문장 이내의 한글 인사이트를 제공하세요.

응답 형식 (JSON):
{
  "insights": [
    "격려와 분석이 담긴 한글 문장 1",
    "격려와 분석이 담긴 한글 문장 2"
  ],
  "bestDay": "월요일",
  "weakDay": "금요일",
  "topCategory": "공부",
  "nextWeekPlan": {
    "theme": "다음 주 한글 테마",
    "days": [
      { "day": "월", "tasks": ["한글 할 일"] }
    ]
  }
}`;

    const userPrompt = `분석 데이터:
- 달성률: ${rate}% (총 ${total}개 중 ${done}개 완료)
- 요일별/카테고리별 통계 기반 분석

이 데이터를 바탕으로 인사이트를 작성해줘. 절대 한자나 다른 외국어를 사용하지 말고, 자연스러운 한국어로만 답변해줘.`;

    const raw = await callGroq(systemPrompt, userPrompt);
    const parsed = safeParseJSON(raw);

    return res.json({ ...parsed, rate });
  } catch (err) {
    console.error('/ai/analyze 오류:', err);
    return res.status(500).json({ error: 'AI 분석 중 오류가 발생했습니다.' });
  }
});

module.exports = router;
