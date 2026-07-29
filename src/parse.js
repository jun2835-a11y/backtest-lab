// 자연어 → 사전등록 스펙 변환.
// ANTHROPIC_API_KEY가 있으면 Claude로 파싱, 없으면 키워드 폴백 파서로 동작.

import Anthropic from '@anthropic-ai/sdk';
import { STRATEGY_TYPES } from './strategy.js';
import { TICKERS } from './data.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

const TEMPLATE_TYPES = new Set(['ma_timing', 'dual_ma', 'vol_target']);

// 정밀 모드: 그리드 스윕이 필요하므로 3개 템플릿 타입만 허용.
const SYSTEM_PRO = `너는 레버리지 ETF 백테스트 검증 랩의 요청 파서다.
사용자의 자연어 전략 요청을 아래 JSON 스펙으로만 변환한다. 설명 없이 JSON만 출력.

전략 타입(type) — 반드시 아래 셋 중 하나:
- "ma_timing": 종가가 이동평균 위면 보유. fixed: maType("sma"|"ema"). chosenParam=이동평균 일수.
- "dual_ma": 단기MA>장기MA면 보유. fixed: fast(int), maType. chosenParam=장기 일수.
- "vol_target": 롤링변동성<임계면 보유. fixed: window(int). chosenParam=임계.

출력:
{
  "strategy": { "type": "...", "maType": "sma|ema", "fast": 50, "window": 20, "grid": [숫자...생략가능], "chosenParam": 숫자 },
  "passRule": "mdd_and_calmar|beat_bh_calmar|positive_calmar",
  "plateau": { "neighborhood": 1, "tolerance": 0.15 },
  "multiTicker": { "threshold": 3 },
  "tickers": ["TQQQ","SOXL","UPRO","TNA","LABU"],
  "notes": "요청 해석 한 줄"
}
규칙: 종목 미지정 시 5종목 전체. "200일선"은 chosenParam. 알 수 없으면 ma_timing/sma.`;

// 간편 모드: 초보의 아무 문장이나 → 조립식 규칙(rule)로도 구성 가능.
const SYSTEM_SIMPLE = `너는 백테스트 랩의 전략 파서다. 초보 사용자의 자연어 전략을 아래 JSON으로만 변환한다. 설명 없이 JSON만.

간단한 표준 전략이면 템플릿을 쓴다:
- {"type":"ma_timing","maType":"sma"|"ema","chosenParam":이동평균일수}
- {"type":"dual_ma","maType":"sma"|"ema","fast":단기,"chosenParam":장기}   // 골든크로스
- {"type":"vol_target","window":기간,"chosenParam":변동성상한(예 0.025)}

복합/지표 조건(RSI·MACD·볼린저·돌파·모멘텀·AND/OR 등)이면 조립식 규칙을 쓴다.
피연산: 숫자  또는  {"ind":"price"}|{"ind":"sma","period":n}|{"ind":"ema","period":n}
      |{"ind":"rsi","period":n}|{"ind":"roc","period":n}|{"ind":"vol","period":n}
      |{"ind":"high","period":n}|{"ind":"low","period":n}
      |{"ind":"macd","line":"line"|"signal"|"hist"}|{"ind":"bb","period":20,"mult":2,"band":"upper"|"lower"|"mid"}
조건: {"op":">"|"<"|">="|"<="|"cross_up"|"cross_down","left":<피연산>,"right":<피연산>} | {"all":[..]}(AND) | {"any":[..]}(OR) | {"not":cond}

두 가지 형태 중 의미에 맞게 고른다:
(A) 상태형 — "~일 때/~이면 보유·유지": {"type":"rule","label":"..","long":<상태조건>}  (참인 구간 보유)
    ※ 상태형에는 반드시 op ">","<",">=","<=" 만 쓴다(cross 금지). 예: MACD 골든 유지 = macd.line > macd.signal.
(B) 이벤트형 — "~에 진입/매수하고 ~에 청산/매도": {"type":"rule","label":"..","entry":<진입조건>,"exit":<청산조건>}
    진입~청산 사이를 보유. cross_up/cross_down는 여기서만 쓴다.

출력: {"strategy":<템플릿 또는 rule>, "tickers":[문장 속 Yahoo 심볼, 없으면 []], "notes":"한 줄 요약"}
예1) "50일선이 200일선 위일 때만 보유" → {"strategy":{"type":"dual_ma","maType":"sma","fast":50,"chosenParam":200},"tickers":[],"notes":"50/200 골든크로스"}
예2) "MACD 골든크로스에 사고 데드크로스에 판다" → {"strategy":{"type":"rule","label":"MACD 골든 진입·데드 청산","entry":{"op":"cross_up","left":{"ind":"macd","line":"line"},"right":{"ind":"macd","line":"signal"}},"exit":{"op":"cross_down","left":{"ind":"macd","line":"line"},"right":{"ind":"macd","line":"signal"}}},"tickers":[],"notes":"MACD 크로스"}
예3) "RSI 30 아래고 종가가 200일선 위일 때 보유" → {"strategy":{"type":"rule","label":"추세+RSI<30","long":{"all":[{"op":">","left":{"ind":"price"},"right":{"ind":"sma","period":200}},{"op":"<","left":{"ind":"rsi","period":14},"right":30}]}},"tickers":[],"notes":"RSI 저점"}`;

function stripJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : text;
}

// 키워드 폴백 파서 — 키 없이도 합리적 스펙 생성.
export function fallbackParse(nl) {
  const s = (nl || '').toLowerCase();
  const spec = { type: 'ma_timing', maType: 'sma' };
  if (/dual|이중|골든|데드|크로스|cross/.test(s)) spec.type = 'dual_ma';
  if (/변동성|vol|volatility/.test(s)) spec.type = 'vol_target';
  if (/ema|지수이동|지수 이동/.test(s)) spec.maType = 'ema';

  // "200일", "200일선", "200 day" 등에서 숫자 추출 → chosenParam.
  const dayMatch = s.match(/(\d{2,3})\s*(일|day|d\b|봉)/);
  if (dayMatch && spec.type !== 'vol_target') spec.chosenParam = parseInt(dayMatch[1], 10);

  // 종목 추출.
  const tickers = TICKERS.filter((t) => s.includes(t.toLowerCase()));

  // 과반 임계 추출: "3종목", "3/5", "과반".
  let threshold = 3;
  const thMatch = s.match(/(\d)\s*(종목|개).*통과|통과.*(\d)\s*(종목|개)|(\d)\s*\/\s*5/);
  if (thMatch) {
    const n = [thMatch[1], thMatch[3], thMatch[5]].find(Boolean);
    if (n) threshold = parseInt(n, 10);
  }

  // 복합 지표를 원했는데 키워드 폴백이라 조립 불가 → 강등 경고.
  const advanced = /rsi|macd|볼린저|bollinger|돌파|breakout|모멘텀|momentum|밴드|band/.test(s);
  const out = {
    strategy: spec,
    passRule: 'mdd_and_calmar',
    passMargin: 0,
    plateau: { neighborhood: 1, tolerance: 0.15 },
    multiTicker: { threshold },
    tickers: tickers.length ? tickers : TICKERS.slice(),
    notes: `[키워드 폴백] ${STRATEGY_TYPES[spec.type].label}${spec.chosenParam ? `, 기준값 ${spec.chosenParam}` : ''}`,
    engine: 'fallback',
  };
  if (advanced) {
    out.downgraded = true;
    out.downgradeNote = 'RSI·MACD 같은 복합 전략은 서버에 ANTHROPIC_API_KEY가 연결돼야 조립됩니다. 지금은 기본 전략으로 대체했습니다.';
  }
  return out;
}

export async function parseRequest(nl, mode = 'simple') {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fallbackParse(nl); // 폴백은 템플릿만(조립식 규칙은 LLM 필요)
  try {
    const client = new Anthropic({ apiKey: key });
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: mode === 'pro' ? SYSTEM_PRO : SYSTEM_SIMPLE,
      messages: [{ role: 'user', content: nl }],
    });
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const parsed = JSON.parse(stripJson(text));
    parsed.engine = 'llm';

    const type = parsed.strategy?.type;
    const DEFAULT = { type: 'ma_timing', maType: 'sma', chosenParam: 200 };
    const downgrade = (note) => { parsed.strategy = { ...DEFAULT }; parsed.downgraded = true; parsed.downgradeNote = note; };
    if (mode === 'pro') {
      // 정밀 모드: 그리드 스윕 필요 → 템플릿 타입만 허용, 벗어나면 안전 강등.
      if (!TEMPLATE_TYPES.has(type)) downgrade('요청을 정밀 모드 전략으로 해석하지 못해 기본 전략(200일 이동평균)으로 대체했습니다.');
      if (!parsed.tickers || !parsed.tickers.length) parsed.tickers = TICKERS.slice();
    } else {
      // 간편 모드: rule 또는 템플릿 허용. rule이 비정상이면 강등.
      if (type === 'rule' && !parsed.strategy.long && !parsed.strategy.rule && !parsed.strategy.condition && !parsed.strategy.entry && !parsed.strategy.exit)
        downgrade('규칙을 구성하지 못해 기본 전략(200일 이동평균)으로 대체했습니다.');
      else if (!TEMPLATE_TYPES.has(type) && type !== 'rule')
        downgrade('요청을 해석하지 못해 기본 전략(200일 이동평균)으로 대체했습니다.');
      if (!parsed.tickers) parsed.tickers = [];
    }
    return parsed;
  } catch (e) {
    const fb = fallbackParse(nl);
    fb.notes += ` (LLM 파싱 실패: ${String(e.message || e).slice(0, 80)})`;
    return fb;
  }
}
