// 전략 엔진: 파싱된 스펙 → 포지션 신호 배열(0=현금, 1=풀보유).
//
// 각 전략은 "그리드 파라미터" 하나를 노출한다 — 평원(plateau) 검사가 이 축을 훑는다.
// 신호는 룩어헤드를 피하기 위해 1봉 지연 체결(전일 지표로 오늘 포지션 결정).

import { sma, ema, rollingVol, returns, rsi, macd, bollinger, rollingHigh, rollingLow, roc } from './indicators.js';

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

// ── 조립식 규칙 DSL(rule 타입) ──
// LLM이 코드가 아니라 이 JSON 규칙만 생성 → 엔진이 해석(코드 실행 없음 = 안전).
// 피연산자: {ind:'sma'|'ema'|'rsi'|'macd'|'bb'|'high'|'low'|'vol'|'roc'|'price', ...} 또는 숫자/{const:n}
// 조건: {op:'>'|'<'|'>='|'<='|'cross_up'|'cross_down', left, right} / {all:[...]} / {any:[...]} / {not:cond}
function resolveOperand(op, closes) {
  if (typeof op === 'number') return closes.map(() => op);
  if (op == null) return closes.map(() => null);
  if (op.const != null) return closes.map(() => op.const);
  const ind = (op.ind || op.indicator || 'price').toLowerCase();
  const p = op.period || op.p;
  switch (ind) {
    case 'price': case 'close': return closes;
    case 'sma': return sma(closes, p || 50);
    case 'ema': return ema(closes, p || 50);
    case 'rsi': return rsi(closes, p || 14);
    case 'roc': case 'momentum': return roc(closes, p || 20);
    case 'vol': case 'volatility': return rollingVol(returns(closes), p || 20);
    case 'high': return rollingHigh(closes, p || 20);
    case 'low': return rollingLow(closes, p || 20);
    case 'macd': { const m = macd(closes, op.fast || 12, op.slow || 26, op.signal || 9); return m[op.line || 'line'] || m.line; }
    case 'bb': case 'bollinger': { const b = bollinger(closes, p || 20, op.mult || 2); return b[op.band || 'mid'] || b.mid; }
    default: return closes;
  }
}

function evalCond(c, i, series) {
  if (!c || typeof c !== 'object') return false;
  if (Array.isArray(c.all)) return c.all.every((x) => evalCond(x, i, series));
  if (Array.isArray(c.any)) return c.any.some((x) => evalCond(x, i, series));
  if (c.not) return !evalCond(c.not, i, series);
  if (c.op) {
    const L = series(c.left), R = series(c.right);
    const a = L[i], b = R[i];
    if (c.op === 'cross_up') { const a0 = L[i - 1], b0 = R[i - 1]; return a0 != null && b0 != null && a != null && b != null && a0 <= b0 && a > b; }
    if (c.op === 'cross_down') { const a0 = L[i - 1], b0 = R[i - 1]; return a0 != null && b0 != null && a != null && b != null && a0 >= b0 && a < b; }
    if (a == null || b == null) return false;
    switch (c.op) {
      case '>': return a > b; case '<': return a < b;
      case '>=': return a >= b; case '<=': return a <= b;
      case '==': case '=': return a === b;
    }
  }
  return false;
}

export function evalRuleStrategy(spec, closes) {
  const cache = new Map();
  const series = (op) => { const k = JSON.stringify(op); if (cache.has(k)) return cache.get(k); const s = resolveOperand(op, closes); cache.set(k, s); return s; };

  // 진입/청산 이벤트 쌍(cross_up 진입 → cross_down 청산 등): 사이 구간을 보유로 유지.
  if (spec.entry || spec.exit) {
    const raw = new Array(closes.length).fill(0);
    let pos = 0;
    for (let i = 0; i < closes.length; i++) {
      if (pos === 0 && spec.entry && evalCond(spec.entry, i, series)) pos = 1;
      else if (pos === 1 && spec.exit && evalCond(spec.exit, i, series)) pos = 0;
      raw[i] = pos;
    }
    return lag(raw);
  }

  // 상태 조건: 참인 구간만 보유.
  const cond = spec.long || spec.rule || spec.condition || spec;
  const raw = closes.map((_, i) => (evalCond(cond, i, series) ? 1 : 0));
  return lag(raw);
}

// spec + 그리드 값 하나 → 포지션 배열.
export function positionsFor(spec, closes, paramValue) {
  const type = spec.type;
  if (type === 'rule') return evalRuleStrategy(spec, closes);
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
