// 백테스트 엔진: 종가 배열 + 포지션 배열 → 자산곡선 + 성과지표.
// 지표: 총수익, CAGR, MDD, 칼마(CAGR/MDD), 샤프, 노출도.

import { drawdownFromPeak } from './indicators.js';

const TRADING_DAYS = 252;

// 포지션 전환 시 왕복 비용(bps). 레버리지 ETF 스프레드 고려해 넉넉히.
const COST_PER_TURN = 0.0005; // 5bps

// bars: [{iso, close}], positions: number[] (0..1). 동일 길이 가정.
export function runBacktest(bars, positions) {
  const n = bars.length;
  const equity = new Array(n).fill(1);
  const dailyRet = new Array(n).fill(0);
  let exposedDays = 0;
  let turns = 0;

  for (let i = 1; i < n; i++) {
    const assetRet = bars[i].close / bars[i - 1].close - 1;
    const pos = positions[i];
    if (pos > 0) exposedDays++;
    let r = pos * assetRet;
    // 포지션 변경분에 비용 부과.
    const delta = Math.abs(pos - positions[i - 1]);
    if (delta > 0) { r -= delta * COST_PER_TURN; turns++; }
    dailyRet[i] = r;
    equity[i] = equity[i - 1] * (1 + r);
  }

  const closesEq = equity;
  const dd = drawdownFromPeak(closesEq);
  const mdd = Math.max(...dd);
  const totalRet = equity[n - 1] - 1;
  const years = (bars[n - 1].t - bars[0].t) / (365.25 * 86400) || (n / TRADING_DAYS);
  const cagr = years > 0 ? Math.pow(equity[n - 1], 1 / years) - 1 : 0;
  const calmar = mdd > 1e-9 ? cagr / mdd : (cagr > 0 ? Infinity : 0);

  // 샤프(무위험 0 가정, 연율화).
  let mean = 0;
  for (let i = 1; i < n; i++) mean += dailyRet[i];
  mean /= (n - 1);
  let variance = 0;
  for (let i = 1; i < n; i++) variance += (dailyRet[i] - mean) ** 2;
  variance /= (n - 2 || 1);
  const sd = Math.sqrt(variance);
  const sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(TRADING_DAYS) : 0;

  return {
    metrics: {
      totalReturn: totalRet,
      cagr,
      mdd,
      calmar,
      sharpe,
      exposure: n > 1 ? exposedDays / (n - 1) : 0,
      turns,
      years: +years.toFixed(2),
      bars: n,
      from: bars[0].iso,
      to: bars[n - 1].iso,
    },
    equity,
    drawdown: dd,
  };
}

// 매수후보유 벤치마크(항상 100% 노출).
export function buyHold(bars) {
  return runBacktest(bars, new Array(bars.length).fill(1));
}
