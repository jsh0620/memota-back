// ai.js (경로: memota-back/routes/ai.js)
const express = require('express');
const router = express.Router();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

async function callGroq(systemPrompt, userPrompt, temperature = 0.3, fewShot = []) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature,
      max_tokens: 3000,
      messages: [
        { role: 'system', content: systemPrompt },
        ...fewShot,
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: "json_object" }
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

function validateDays(days) {
  if (!Array.isArray(days)) return false;
  for (const day of days) {
    if (typeof day.day !== 'number') return false;
    if (!Array.isArray(day.tasks)) return false;
    // 일별 최대 2개 제한
    if (day.tasks.length > 2) day.tasks = day.tasks.slice(0, 2);
  }
  return true;
}

// ── POST /ai/plan ─────────────────────────────────────
router.post('/plan', async (req, res) => {
  try {
    const { goal, detail, totalDays } = req.body;
    if (!goal) return res.status(400).json({ error: '목표는 필수입니다.' });
    if (!totalDays || totalDays < 1 || totalDays > 14) {
      return res.status(400).json({ error: '기간은 1일~14일 사이여야 합니다.' });
    }

    const PLAN_SYSTEM = `당신은 사용자의 목표를 분석하여 실천 가능한 N일차 계획을 설계하는 전문 코치입니다.

[절대 규칙]
1. 모든 텍스트는 100% 순수 한국어(한글)로만 작성합니다. 영어 단어도 한글 발음으로 표기합니다.
2. 반드시 유효한 JSON 형식으로만 응답합니다. 코드블록이나 설명 텍스트를 절대 붙이지 않습니다.
3. 일별 할 일은 최대 2개, 권장 1개로 제한합니다. 실천 가능성이 최우선입니다.
4. 각 할 일은 "무엇을 얼마나" 알 수 있는 구체적 행동으로 작성합니다. (나쁜 예: "공부하기" / 좋은 예: "단어 20개 암기")
5. days 배열에는 반드시 1일차부터 totalDays일차까지 모든 일차가 포함되어야 합니다.
6. tasks가 없는 날도 빈 배열 []로 반드시 포함합니다.
7. 쉬는 날(tasks:[])을 적절히 배치해 무리하지 않는 계획을 만드세요.

[반려 기준 - rejected: true로 응답]
- 목표가 단어 1~2개뿐이고 내용 파악이 불가한 경우 (예: "공부", "운동", "시험")
- 무엇을 할지 대상이 전혀 없는 경우 (예: "열심히 살기", "잘 되고 싶다")
- 의미 없는 단어 나열 (예: "ㅁㄴㅇ", "asdf", "테스트")
- 폭력적이거나 비윤리적인 내용

[정상 처리 기준]
- 과목/분야/활동이 명시된 경우 정상 처리 (예: "토익 공부", "3킬로미터 달리기")
- 초반 → 중반 → 마무리 흐름으로 구성하고 마지막 날에 복습/점검 포함
- 전체 기간의 흐름을 고려해 점진적으로 난이도 조절

[정상 응답 형식]
{
  "rejected": false,
  "summary": "2문장 이내 계획 요약",
  "days": [
    { "day": 1, "tasks": ["구체적 행동 1개"] },
    { "day": 2, "tasks": ["구체적 행동 1개"] },
    { "day": 3, "tasks": [] },
    ...
    { "day": N, "tasks": ["마무리 복습"] }
  ]
}

[반려 응답 형식]
{ "rejected": true, "message": "친절하고 구체적인 안내 메시지" }`;

    const PLAN_FEW_SHOT = [
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
        content: '목표: 매일 3킬로미터 달리기\n세부사항: 현재 운동 전혀 안 함, 아침 시간 활용\n기간: 7일'
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          rejected: false,
          summary: '운동 습관이 없는 상태에서 7일 동안 걷기부터 시작해 3킬로미터 달리기에 도전하는 점진적 훈련입니다.',
          days: [
            { day: 1, tasks: ['아침 걷기 20분'] },
            { day: 2, tasks: ['걷기 15분 후 달리기 5분'] },
            { day: 3, tasks: [] },
            { day: 4, tasks: ['걷기 10분 후 달리기 10분'] },
            { day: 5, tasks: ['달리기 15분 도전'] },
            { day: 6, tasks: ['스트레칭 10분 + 가벼운 걷기'] },
            { day: 7, tasks: ['3킬로미터 완주 도전'] }
          ]
        })
      }
    ];

    const userPrompt = `목표: ${goal}\n세부사항: ${detail || '없음'}\n기간: ${totalDays}일\n\n위 목표에 맞는 ${totalDays}일치 계획을 1일차부터 ${totalDays}일차까지 생성해줘. 일별 할 일은 최대 2개로 제한하고, 가능하면 1개만 배치해. 쉬는 날도 적절히 포함해.`;

    const raw = await callGroq(PLAN_SYSTEM, userPrompt, 0.25, PLAN_FEW_SHOT);
    const parsed = safeParseJSON(raw);

    if (!parsed.rejected) {
      // AI가 days 대신 weeks나 plan 같은 다른 키로 줄 경우 복구 시도
      if (!Array.isArray(parsed.days)) {
        // weeks 구조로 온 경우 days로 변환 시도
        if (Array.isArray(parsed.weeks)) {
          let dayNum = 1;
          const flatDays = [];
          for (const week of parsed.weeks) {
            for (const day of (week.days || [])) {
              flatDays.push({ day: dayNum++, tasks: Array.isArray(day.tasks) ? day.tasks : [] });
            }
          }
          if (flatDays.length > 0) {
            parsed.days = flatDays;
          } else {
            console.warn('/ai/plan 구조 복구 실패, raw:', raw.substring(0, 300));
            return res.status(500).json({ error: 'AI 응답 구조가 올바르지 않아요. 다시 시도해주세요.' });
          }
        } else {
          console.warn('/ai/plan 구조 검증 실패, raw:', raw.substring(0, 300));
          return res.status(500).json({ error: 'AI 응답 구조가 올바르지 않아요. 다시 시도해주세요.' });
        }
      }
      // days 배열 길이가 totalDays와 맞지 않으면 채워줌
      while (parsed.days.length < totalDays) {
        parsed.days.push({ day: parsed.days.length + 1, tasks: [] });
      }
      validateDays(parsed.days);
    }

    return res.json(parsed);
  } catch (err) {
    console.error('/ai/plan 오류:', err);
    return res.status(500).json({ error: 'AI 계획 생성 중 오류: ' + err.message });
  }
});

// ── POST /ai/analyze ──────────────────────────────────
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

    const ANALYZE_SYSTEM = `당신은 개인 생산성 코치 AI입니다.

[절대 규칙]
1. 모든 텍스트는 100% 순수 한국어(한글)로만 작성합니다.
2. 반드시 유효한 JSON 형식으로만 응답합니다. 코드블록이나 설명을 절대 붙이지 않습니다.
3. 요일별 할 일은 최대 2개, 권장 1개로 제한합니다.
4. 미완료 항목 중 중요한 것을 이어받되, 완료율 낮은 요일은 할 일을 줄입니다.
5. nextWeekPlan의 days 배열에는 반드시 월,화,수,목,금,토,일 순서로 7개 요일 객체가 모두 있어야 합니다.
6. tasks가 없는 날도 빈 배열 []로 반드시 포함합니다.
7. 톤은 따뜻하고 격려하는 말투를 사용합니다.

[분석 접근법]
- 완료율이 높은 요일의 패턴을 파악해 강점으로 활용합니다.
- 완료율이 낮은 요일은 할 일을 줄이거나 더 쉬운 것으로 조정합니다.
- 미완료 항목은 다음 주로 이어받되 더 작게 쪼개어 배치합니다.

[응답 형식]
{
  "insights": ["구체적 인사이트 문장 1", "구체적 인사이트 문장 2", "다음 주 전략 제안"],
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
      { "day": "토", "tasks": ["복습 또는 정리"] },
      { "day": "일", "tasks": [] }
    ]
  }
}`;

    const ANALYZE_FEW_SHOT = [
      {
        role: 'user',
        content: '달성률: 50%, 요일별: {"월":{"total":1,"done":1},"화":{"total":2,"done":0}}, 할 일: [{"text":"영어 단어","completed":true},{"text":"수학 풀기","completed":false},{"text":"독서","completed":false}]'
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          insights: [
            '월요일에는 꾸준히 완료하고 있어요. 이 루틴을 계속 이어가세요!',
            '화요일에 할 일이 몰려 완료율이 낮았어요. 하루 1개로 줄여볼게요.',
            '다음 주는 요일당 1개씩 배치해 지속 가능한 루틴을 만들어봐요.'
          ],
          bestDay: '월요일',
          weakDay: '화요일',
          nextWeekPlan: {
            theme: '하루 1개씩 꾸준히 완료하는 한 주',
            days: [
              { day: '월', tasks: ['영어 단어 20개 암기'] },
              { day: '화', tasks: ['수학 문제 3개 풀기'] },
              { day: '수', tasks: ['영어 단어 20개 복습'] },
              { day: '목', tasks: ['독서 20분'] },
              { day: '금', tasks: ['이번 주 학습 내용 정리'] },
              { day: '토', tasks: [] },
              { day: '일', tasks: [] }
            ]
          }
        })
      }
    ];

    const userPrompt = `분석 데이터:
- 전체 달성률: ${rate}% (총 ${total}개 중 ${done}개 완료)
- 요일별 통계: ${JSON.stringify(dayStats)}
- 최근 2주 할 일: ${JSON.stringify(recentTasks.map(t=>({date:t.date,text:t.text,completed:t.completed})))}

위 데이터를 바탕으로 패턴을 분석하고 다음 주 실천 가능한 계획을 추천해줘. 요일별 할 일은 최대 2개, 가능하면 1개만 배치해.`;

    const raw = await callGroq(ANALYZE_SYSTEM, userPrompt, 0.35, ANALYZE_FEW_SHOT);
    const parsed = safeParseJSON(raw);

    if (!parsed.nextWeekPlan || !Array.isArray(parsed.nextWeekPlan.days)) {
      console.warn('/ai/analyze 구조 검증 실패, raw:', raw.substring(0, 300));
      return res.status(500).json({ error: 'AI 응답 구조가 올바르지 않아요. 다시 시도해주세요.' });
    }

    parsed.nextWeekPlan.days.forEach(d => {
      if (Array.isArray(d.tasks) && d.tasks.length > 2) d.tasks = d.tasks.slice(0, 2);
    });

    return res.json({ ...parsed, rate });
  } catch (err) {
    console.error('/ai/analyze 오류:', err);
    return res.status(500).json({ error: 'AI 분석 중 오류: ' + err.message });
  }
});

module.exports = router;
