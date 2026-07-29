// 통계 정직성 층: OOS 분리·블록 부트스트랩 신뢰구간·타이밍 셔플 랜덤대조.
// 재현성을 위해 시드 PRNG 사용(같은 입력 → 같은 결과).

import { runBacktest } from './backtest.js';

// 결정론적 PRNG (mulberry32) + 문자열 해시(FNV-1a).
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clampCal = (c) => !isFinite(c) ? (c > 0 ? 10 : -10) : Math.max(-10, Math.min(10, c));
const quantile = (sorted, q) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1))))];

// 일간수익 경로 → 칼마.
function calmarOfReturns(rets) {
  let eq = 1, peak = 1, mdd = 0;
  for (let i = 0; i < rets.length; i++) {
    eq *= (1 + rets[i]);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? 1 - eq / peak : 0;
    if (dd > mdd) mdd = dd;
  }
  const n = rets.length, years = n / 252;
  const cagr = years > 0 && eq > 0 ? Math.pow(eq, 1 / years) - 1 : -1;
  return mdd > 1e-9 ? cagr / mdd : (cagr > 0 ? Infinity : 0);
}

// 자산곡선(equity) → 일간수익.
export function equityToReturns(equity) {
  const r = [];
  for (let i = 1; i < equity.length; i++) r.push(equity[i] / equity[i - 1] - 1);
  return r;
}

// 블록 부트스트랩: 전략 일간수익을 블록 단위 재표집 → 칼마 분포 → 90% 신뢰구간.
export function bootstrapCalmarCI(rets, { block = 20, iters = 300, rng }) {
  const n = rets.length;
  if (n < block * 2) return null;
  const out = [];
  for (let it = 0; it < iters; it++) {
    const path = [];
    while (path.length < n) {
      const start = Math.floor(rng() * n);
      for (let k = 0; k < block && path.length < n; k++) path.push(rets[(start + k) % n]);
    }
    out.push(clampCal(calmarOfReturns(path)));
  }
  out.sort((a, b) => a - b);
  return { lo: quantile(out, 0.05), med: quantile(out, 0.5), hi: quantile(out, 0.95) };
}

// 포지션 배열을 연속 구간(run)으로 분해.
function toRuns(positions) {
  const runs = [];
  let i = 0;
  while (i < positions.length) {
    let j = i;
    while (j < positions.length && positions[j] === positions[i]) j++;
    runs.push({ v: positions[i], len: j - i });
    i = j;
  }
  return runs;
}

// 타이밍 셔플 랜덤대조: 같은 보유량(노출)·같은 회전(run 길이)을 유지한 채
// 구간 순서만 무작위로 섞음 → "타이밍이 우연 대비 유의미한가" 검정.
// 반환: 전략 칼마의 백분위(랜덤 분포 중 몇 %가 전략보다 낮은가) + 밴드.
export function timingShuffleControl(bars, positions, stratCalmar, { iters = 200, rng, opts = {} }) {
  const runs = toRuns(positions);
  if (runs.length < 3) return null;
  const cals = [];
  for (let it = 0; it < iters; it++) {
    const order = runs.slice();
    for (let i = order.length - 1; i > 0; i--) { const k = Math.floor(rng() * (i + 1)); [order[i], order[k]] = [order[k], order[i]]; }
    const pos = new Array(positions.length);
    let idx = 0;
    for (const run of order) { for (let k = 0; k < run.len; k++) pos[idx++] = run.v; }
    cals.push(clampCal(runBacktest(bars, pos, opts).metrics.calmar));
  }
  cals.sort((a, b) => a - b);
  const sc = clampCal(stratCalmar);
  const below = cals.filter((c) => c < sc).length;
  return { percentile: below / cals.length, lo: quantile(cals, 0.05), med: quantile(cals, 0.5), hi: quantile(cals, 0.95) };
}

// 표본 외(OOS) 분리 지점: 앞 train 비율.
export function oosSplitIndex(n, trainFrac = 0.6) {
  return Math.max(30, Math.min(n - 30, Math.floor(n * trainFrac)));
}
