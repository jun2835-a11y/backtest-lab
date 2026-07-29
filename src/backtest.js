// 백테스트 엔진: 종가 배열 + 포지션 배열 → 자산곡선 + 성과지표.
// 지표: 총수익, CAGR, MDD, 칼마(CAGR/MDD), 샤프, 노출도.
//
// 비용 모델(투명하게 노출):
//  · turnCost: 포지션 전환 시 왕복 비용(bps). 슬리피지/스프레드 근사.
//  · expenseRatio: 연 운용보수. 보유(노출) 구간에만 일할 차감.
//    주의: 실제 ETF 조정종가와 data.js 합성 시계열은 이미 net-of-fee라
//    이중차감을 피하려 기본값 0. 총수익(gross) 계열에만 켠다.

const TRADING_DAYS = 252;
const DEFAULT_TURN_COST = 0.0005; // 5bps

// bars: [{iso, close}], positions: number[] (0..1). 동일 길이 가정.
// opts: { turnCost, expenseRatio }
export function runBacktest(bars, positions, opts = {}) {
  const turnCost = opts.turnCost ?? DEFAULT_TURN_COST;
  const expenseRatio = opts.expenseRatio ?? 0;
  const dailyExpense = expenseRatio / TRADING_DAYS;

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
    if (pos > 0 && dailyExpense) r -= pos * dailyExpense; // 보유 구간 운용보수
    const delta = Math.abs(pos - positions[i - 1]);
    if (delta > 0) { r -= delta * turnCost; turns++; }
    dailyRet[i] = r;
    equity[i] = equity[i - 1] * (1 + r);
  }

  // 낙폭 최대값 — reduce로(큰 배열에서 Math.max(...arr) 스택오버플로 방지).
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

  // 샤프(무위험 0 가정, 연율화).
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
      costModel: { turnCost, expenseRatio },
    },
    equity,
    drawdown: dd,
  };
}

// 매수후보유 벤치마크(항상 100% 노출).
export function buyHold(bars, opts = {}) {
  return runBacktest(bars, new Array(bars.length).fill(1), opts);
}
