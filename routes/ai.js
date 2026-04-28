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
      temperature: 0.7,
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
  // ```json ... ``` 마크다운 코드블록 제거
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
사용자의 목표를 분석하여 구체적이고 실행 가능한 주차별/요일별 계획을 생성합니다.

규칙:
1. 반드시 유효한 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요.
2. 목표가 너무 추상적이거나 불분명하면 rejected: true를 반환하세요.
3. 모든 내용은 한국어로 작성하세요.
4. 각 할 일은 15자 이내의 간결한 문장으로 작성하세요.
5. 하루에 2~4개의 할 일만 배정하세요.

응답 형식 (목표가 구체적인 경우):
{
  "rejected": false,
  "weeks": [
    {
      "week": 1,
      "theme": "이번 주 핵심 목표",
      "days": [
        { "day": "월", "tasks": ["할 일1", "할 일2"] },
        { "day": "화", "tasks": ["할 일1"] },
        { "day": "수", "tasks": ["할 일1", "할 일2"] },
        { "day": "목", "tasks": ["할 일1"] },
        { "day": "금", "tasks": ["할 일1", "할 일2"] },
        { "day": "토", "tasks": ["할 일1"] },
        { "day": "일", "tasks": ["할 일1"] }
      ]
    }
  ]
}

응답 형식 (목표가 너무 추상적인 경우):
{
  "rejected": true,
  "reason": "목표가 너무 추상적입니다. 예: '토익 800점 달성', '매일 30분 운동하기', '파이썬 기초 완성' 처럼 구체적으로 입력해주세요."
}`;

    const userPrompt = `목표: ${goal}
기간: ${duration}주
${detail ? `세부 사항: ${detail}` : ''}

위 목표에 맞는 ${duration}주 계획을 생성해주세요.`;

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

    // 최근 2주 데이터만 필터링
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

    // 통계 계산
    const total = recentTasks.length;
    const done = recentTasks.filter(t => t.completed).length;
    const rate = Math.round((done / total) * 100);

    // 요일별 통계
    const dayStats = {};
    const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
    recentTasks.forEach(t => {
      const day = DAY_NAMES[new Date(t.date).getDay()];
      if (!dayStats[day]) dayStats[day] = { total: 0, done: 0 };
      dayStats[day].total++;
      if (t.completed) dayStats[day].done++;
    });

    // 카테고리별 통계
    const catStats = {};
    recentTasks.forEach(t => {
      const cat = t.category || '기타';
      if (!catStats[cat]) catStats[cat] = { total: 0, done: 0 };
      catStats[cat].total++;
      if (t.completed) catStats[cat].done++;
    });

    const systemPrompt = `당신은 개인 생산성 코치 AI입니다.
사용자의 최근 2주 플래너 데이터를 분석하여 인사이트와 다음 주 추천 계획을 생성합니다.

규칙:
1. 반드시 유효한 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요.
2. 모든 내용은 한국어로 작성하세요.
3. 인사이트는 2~3문장의 따뜻하고 격려하는 톤으로 작성하세요.
4. 다음 주 추천 할 일은 각 15자 이내로 작성하세요.
5. 하루에 2~3개의 할 일만 배정하세요.

응답 형식:
{
  "insights": [
    "인사이트 문장 1",
    "인사이트 문장 2",
    "인사이트 문장 3"
  ],
  "bestDay": "가장 생산적인 요일",
  "weakDay": "가장 약한 요일",
  "topCategory": "가장 많이 한 카테고리",
  "nextWeekPlan": {
    "theme": "다음 주 추천 테마",
    "days": [
      { "day": "월", "tasks": ["할 일1", "할 일2"] },
      { "day": "화", "tasks": ["할 일1"] },
      { "day": "수", "tasks": ["할 일1", "할 일2"] },
      { "day": "목", "tasks": ["할 일1"] },
      { "day": "금", "tasks": ["할 일1", "할 일2"] },
      { "day": "토", "tasks": ["할 일1"] },
      { "day": "일", "tasks": ["할 일1"] }
    ]
  }
}`;

    const userPrompt = `최근 2주 분석 데이터:
- 전체 할 일: ${total}개
- 완료한 할 일: ${done}개
- 전체 달성률: ${rate}%

요일별 통계:
${Object.entries(dayStats).map(([day, s]) => `- ${day}요일: ${s.total}개 중 ${s.done}개 완료 (${Math.round(s.done/s.total*100)}%)`).join('\n')}

카테고리별 통계:
${Object.entries(catStats).map(([cat, s]) => `- ${cat}: ${s.total}개 중 ${s.done}개 완료`).join('\n')}

최근 2주 할 일 목록:
${recentTasks.slice(0, 30).map(t => `- [${t.date}] ${t.text} (${t.completed ? '완료' : '미완료'}) [${t.category || '기타'}]`).join('\n')}

위 데이터를 분석하여 인사이트와 다음 주 추천 계획을 생성해주세요.`;

    const raw = await callGroq(systemPrompt, userPrompt);
    const parsed = safeParseJSON(raw);

    return res.json({ ...parsed, rate });
  } catch (err) {
    console.error('/ai/analyze 오류:', err);
    return res.status(500).json({ error: 'AI 분석 중 오류가 발생했습니다.' });
  }
});

module.exports = router;