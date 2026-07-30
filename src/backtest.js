// 백테스트 엔진: 종가 배열 + 포지션 배열 → 자산곡선 + 성과지표.
// 지표: 총수익, CAGR, MDD, 칼마(CAGR/MDD), 샤프, 노출도.
//
// 거래비용 모델(현실화):
//   회전(포지션 변경) 1단위당 편도 비용 =
//     수수료(commissionBps) + 반스프레드(halfSpreadBps) + 슬리피지(slippageVolMult × 그 시점 일간변동성)
//   → 변동성 높은 레버리지 ETF·급변장일수록 비용이 커지고, 잦은 회전 전략이 더 많이 냄.
//   진입·청산에 각각 부과되므로 왕복은 편도의 2배.
// 운용보수(expenseRatio): 보유 구간에만 일할 차감(기본 0 — 실 ETF·합성은 이미 net-of-fee).

import { returns, rollingVol } from './indicators.js';

const TRADING_DAYS = 252;

// bars: [{t, iso, close}], positions: number[] (0..1). opts로 비용 모델 조정.
export function runBacktest(bars, positions, opts = {}) {
  const n = bars.length;
  // 레거시 turnCost(고정 편도) 지원: 신모델 파라미터가 없을 때만.
  const legacy = opts.turnCost != null && opts.halfSpreadBps == null && opts.slippageVolMult == null;
  const commissionBps = opts.commissionBps ?? 0;
  const halfSpreadBps = opts.halfSpreadBps ?? (legacy ? opts.turnCost * 1e4 : 2);
  const slippageVolMult = opts.slippageVolMult ?? (legacy ? 0 : 0.05);
  const volWindow = opts.volWindow ?? 20;
  const dailyExpense = (opts.expenseRatio ?? 0) / TRADING_DAYS;
  const baseOneway = (commissionBps + halfSpreadBps) / 1e4;

  const closes = bars.map((b) => b.close);
  const vol = rollingVol(returns(closes), volWindow); // 그 시점 일간변동성(분수)
  const fallbackVol = 0.02;

  const equity = new Array(n).fill(1);
  const dailyRet = new Array(n).fill(0);
  let exposedDays = 0, turns = 0, costPaid = 0;

  for (let i = 1; i < n; i++) {
    const assetRet = bars[i].close / bars[i - 1].close - 1;
    const pos = positions[i];
    if (pos > 0) exposedDays++;
    let r = pos * assetRet;
    if (pos > 0 && dailyExpense) r -= pos * dailyExpense;
    const delta = Math.abs(pos - positions[i - 1]);
    if (delta > 0) {
      const v = (vol[i] != null && isFinite(vol[i])) ? vol[i] : fallbackVol;
      const oneway = baseOneway + slippageVolMult * v;
      const c = delta * oneway;
      r -= c; costPaid += c; turns++;
    }
    dailyRet[i] = r;
    equity[i] = equity[i - 1] * (1 + r);
  }

  // MDD — 단일 순회(대형 배열 스택오버플로 방지).
  let peak = -Infinity, mdd = 0;
  const dd = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (equity[i] > peak) peak = equity[i];
    dd[i] = peak > 0 ? 1 - equity[i] / peak : 0;
    if (dd[i] > mdd) mdd = dd[i];
  }

  const totalRet = equity[n - 1] - 1;
  const years = (bars[n - 1].t - bars[0].t) / (365.25 * 86400) || (n / TRADING_DAYS);
  const cagr = years > 0 ? Math.pow(equity[n - 1], 1 / years) - 1 : 0;
  const calmar = mdd > 1e-9 ? cagr / mdd : (cagr > 0 ? Infinity : 0);

  let mean = 0;
  for (let i = 1; i < n; i++) mean += dailyRet[i];
  mean /= (n - 1 || 1);
  let variance = 0;
  for (let i = 1; i < n; i++) variance += (dailyRet[i] - mean) ** 2;
  variance /= (n - 2 || 1);
  const sd = Math.sqrt(variance);
  const sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(TRADING_DAYS) : 0;

  return {
    metrics: {
      totalReturn: totalRet, cagr, mdd, calmar, sharpe,
      exposure: n > 1 ? exposedDays / (n - 1) : 0,
      turns, years: +years.toFixed(2), bars: n,
      from: bars[0].iso, to: bars[n - 1].iso,
      costModel: { commissionBps, halfSpreadBps, slippageVolMult, expenseRatio: opts.expenseRatio ?? 0 },
      costPaid,                                   // 총 비용(수익률 기준 누적 차감분)
      avgTurnBps: turns ? (costPaid / turns) * 1e4 : 0, // 회전당 평균 편도 비용(bps)
    },
    equity,
    drawdown: dd,
  };
}

// 매수후보유 벤치마크(항상 100% 노출, 회전 없음).
export function buyHold(bars, opts = {}) {
  return runBacktest(bars, new Array(bars.length).fill(1), opts);
}
