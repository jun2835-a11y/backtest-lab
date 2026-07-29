// 자연어 → 사전등록 스펙 변환.
// ANTHROPIC_API_KEY가 있으면 Claude로 파싱, 없으면 키워드 폴백 파서로 동작.

import Anthropic from '@anthropic-ai/sdk';
import { STRATEGY_TYPES } from './strategy.js';
import { TICKERS } from './data.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

const SYSTEM = `너는 레버리지 ETF 백테스트 검증 랩의 요청 파서다.
사용자의 자연어 전략 요청을 아래 JSON 스펙으로만 변환한다. 설명 없이 JSON만 출력.

전략 타입(type):
- "ma_timing": 종가가 이동평균 위면 보유. gridParam=period. fixed: maType("sma"|"ema").
- "dual_ma": 단기MA>장기MA면 보유. gridParam=slow. fixed: fast(int), maType.
- "vol_target": 롤링변동성<임계면 보유. gridParam=volCap. fixed: window(int).

출력 JSON 형태:
{
  "strategy": { "type": "...", "maType": "sma|ema", "fast": 50, "window": 20,
                "grid": [숫자 배열 또는 생략], "chosenParam": 숫자또는생략 },
  "passRule": "mdd_and_calmar|beat_bh_calmar|positive_calmar",
  "passMargin": 0,
  "plateau": { "neighborhood": 1, "tolerance": 0.15 },
  "multiTicker": { "threshold": 3 },
  "tickers": ["TQQQ","SOXL","UPRO","TNA","LABU"],
  "notes": "요청 해석 한 줄"
}

규칙:
- 종목 미지정 시 5종목 전체 사용.
- 그리드·chosenParam 미지정 시 생략(서버 기본값 사용).
- "200일선" 같은 표준값은 chosenParam으로.
- 알 수 없으면 ma_timing/sma 기본.`;

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

  return {
    strategy: spec,
    passRule: 'mdd_and_calmar',
    passMargin: 0,
    plateau: { neighborhood: 1, tolerance: 0.15 },
    multiTicker: { threshold },
    tickers: tickers.length ? tickers : TICKERS.slice(),
    notes: `[키워드 폴백] ${STRATEGY_TYPES[spec.type].label}${spec.chosenParam ? `, 기준값 ${spec.chosenParam}` : ''}, ${threshold}/5 통과 요구`,
    engine: 'fallback',
  };
}

export async function parseRequest(nl) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fallbackParse(nl);
  try {
    const client = new Anthropic({ apiKey: key });
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: nl }],
    });
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const parsed = JSON.parse(stripJson(text));
    parsed.engine = 'llm';
    if (!parsed.tickers || !parsed.tickers.length) parsed.tickers = TICKERS.slice();
    return parsed;
  } catch (e) {
    const fb = fallbackParse(nl);
    fb.notes += ` (LLM 파싱 실패: ${String(e.message || e).slice(0, 80)})`;
    return fb;
  }
}
