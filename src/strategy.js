// 전략 엔진: 파싱된 스펙 → 포지션 신호 배열(0=현금, 1=풀보유).
//
// 각 전략은 "그리드 파라미터" 하나를 노출한다 — 평원(plateau) 검사가 이 축을 훑는다.
// 신호는 룩어헤드를 피하기 위해 1봉 지연 체결(전일 지표로 오늘 포지션 결정).

import { sma, ema, rollingVol, returns } from './indicators.js';

// 지원 전략 타입 카탈로그. 각 타입은 grid 파라미터의 기본 그리드를 가진다.
export const STRATEGY_TYPES = {
  ma_timing: {
    label: '이동평균 타이밍 (종가 > MA면 보유)',
    gridParam: 'period',
    defaultGrid: [100, 120, 140, 160, 180, 200, 220, 240, 260],
    fixedDefaults: { maType: 'sma' },
  },
  dual_ma: {
    label: '이중 이동평균 (단기MA > 장기MA면 보유)',
    gridParam: 'slow',
    defaultGrid: [120, 150, 180, 200, 220, 250, 280],
    fixedDefaults: { maType: 'sma', fast: 50 },
  },
  vol_target: {
    label: '변동성 관문 (롤링변동성 < 임계면 보유)',
    gridParam: 'volCap',
    defaultGrid: [0.015, 0.020, 0.025, 0.030, 0.035, 0.040],
    fixedDefaults: { window: 20 },
  },
};

// 한 봉 지연 적용: raw[i]는 i봉 종가 기준 판정 → 실제 포지션은 i+1부터 적용.
function lag(raw) {
  const out = new Array(raw.length).fill(0);
  for (let i = 1; i < raw.length; i++) out[i] = raw[i - 1] ? 1 : 0;
  return out;
}

// spec + 그리드 값 하나 → 포지션 배열.
export function positionsFor(spec, closes, paramValue) {
  const type = spec.type;
  if (type === 'ma_timing') {
    const p = paramValue;
    const line = (spec.maType || 'sma') === 'ema' ? ema(closes, p) : sma(closes, p);
    const raw = closes.map((c, i) => (line[i] != null && c > line[i]) ? 1 : 0);
    return lag(raw);
  }
  if (type === 'dual_ma') {
    const fast = spec.fast || 50;
    const slow = paramValue;
    const f = (spec.maType || 'sma') === 'ema' ? ema(closes, fast) : sma(closes, fast);
    const s = (spec.maType || 'sma') === 'ema' ? ema(closes, slow) : sma(closes, slow);
    const raw = closes.map((_, i) => (f[i] != null && s[i] != null && f[i] > s[i]) ? 1 : 0);
    return lag(raw);
  }
  if (type === 'vol_target') {
    const w = spec.window || 20;
    const cap = paramValue;
    const vol = rollingVol(returns(closes), w);
    const raw = closes.map((_, i) => (vol[i] != null && vol[i] < cap) ? 1 : 0);
    return lag(raw);
  }
  throw new Error(`알 수 없는 전략 타입: ${type}`);
}

// spec에서 유효 그리드 산출(사전등록에서 잠근 값 우선).
export function gridFor(spec) {
  const meta = STRATEGY_TYPES[spec.type];
  if (!meta) throw new Error(`알 수 없는 전략 타입: ${spec.type}`);
  const g = spec.grid && Array.isArray(spec.grid) && spec.grid.length ? spec.grid : meta.defaultGrid;
  return { gridParam: meta.gridParam, grid: g.slice() };
}

// 정규화: LLM/폼에서 온 부분 스펙을 완전한 실행 스펙으로.
export function normalizeSpec(spec) {
  const meta = STRATEGY_TYPES[spec.type];
  if (!meta) throw new Error(`지원하지 않는 전략 타입: ${spec.type}`);
  const out = { ...meta.fixedDefaults, ...spec };
  const g = gridFor(out);
  out.grid = g.grid;
  out.gridParam = g.gridParam;
  return out;
}
