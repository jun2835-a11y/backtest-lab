// 포트폴리오 엔진: 여러 종목을 하나의 포트폴리오로 묶어 배분·리밸런싱·기여도 분해.
// 공통 날짜축(교집합)에서 각 종목 슬리브(sleeve)를 굴리고, 신호 off면 그 슬리브는 현금.

import { returns, rollingVol } from './indicators.js';

// 여러 종목 bars를 공통 날짜(교집합)로 정렬.
export function alignSeries(perTicker) {
  const tickers = Object.keys(perTicker);
  const maps = {};
  for (const t of tickers) { const m = new Map(); for (const b of perTicker[t]) m.set(b.iso, b.close); maps[t] = m; }
  let common = [...maps[tickers[0]].keys()];
  for (let k = 1; k < tickers.length; k++) { const m = maps[tickers[k]]; common = common.filter((iso) => m.has(iso)); }
  common.sort();
  const closesByTicker = {};
  for (const t of tickers) closesByTicker[t] = common.map((iso) => maps[t].get(iso));
  const tByDate = new Map(); for (const b of perTicker[tickers[0]]) tByDate.set(b.iso, b.t);
  const ts = common.map((iso) => tByDate.get(iso));
  return { dates: common, ts, closesByTicker, tickers };
}

function isBoundary(prevIso, iso, freq) {
  if (!freq || freq === 'none') return false;
  const py = prevIso.slice(0, 4), pm = +prevIso.slice(5, 7), y = iso.slice(0, 4), m = +iso.slice(5, 7);
  if (freq === 'monthly') return py !== y || pm !== m;
  if (freq === 'quarterly') return py !== y || Math.floor((pm - 1) / 3) !== Math.floor((m - 1) / 3);
  if (freq === 'yearly') return py !== y;
  return false;
}

// 목표 가중치: 동일가중 / 역변동성 / 직접.
export function computeWeights(aligned, method, custom) {
  const { tickers, closesByTicker } = aligned;
  if (method === 'custom' && custom) {
    const sum = tickers.reduce((s, t) => s + (Number(custom[t]) || 0), 0) || 1;
    const w = {}; tickers.forEach((t) => w[t] = (Number(custom[t]) || 0) / sum); return w;
  }
  if (method === 'inverseVol') {
    const inv = {}; let sum = 0;
    for (const t of tickers) {
      const r = returns(closesByTicker[t]);
      let m = 0; for (const x of r) m += x; m /= (r.length || 1);
      let v = 0; for (const x of r) v += (x - m) ** 2; v = Math.sqrt(v / (r.length || 1)) || 1e-6;
      inv[t] = 1 / v; sum += inv[t];
    }
    const w = {}; tickers.forEach((t) => w[t] = inv[t] / sum); return w;
  }
  const w = {}; tickers.forEach((t) => w[t] = 1 / tickers.length); return w;
}

// 포트폴리오 시뮬레이션. positionsByTicker: {ticker: 지연·오버레이 적용 포지션(공통축)}.
export function simulatePortfolio(aligned, positionsByTicker, weights, opts = {}) {
  const { dates, ts, closesByTicker, tickers } = aligned;
  const n = dates.length;
  const cost = opts.costOpts || {};
  const base = ((cost.commissionBps || 0) + (cost.halfSpreadBps ?? 2)) / 1e4;
  const svm = cost.slippageVolMult ?? 0.05;
  const rebalance = opts.rebalance || 'none';
  const vols = {}; for (const t of tickers) vols[t] = rollingVol(returns(closesByTicker[t]), cost.volWindow || 20);

  const v = {}; for (const t of tickers) v[t] = weights[t];
  const contrib = {}, wsum = {}; for (const t of tickers) { contrib[t] = 0; wsum[t] = 0; }
  const equity = new Array(n).fill(1), dd = new Array(n).fill(0);
  let peak = 1, mdd = 0, turns = 0, costPaid = 0, rebalances = 0;
  const rebalDates = [];

  for (let i = 1; i < n; i++) {
    let totalPrev = 0; for (const t of tickers) totalPrev += v[t];
    for (const t of tickers) {
      const ret = closesByTicker[t][i] / closesByTicker[t][i - 1] - 1;
      const pos = positionsByTicker[t][i];
      let sret = pos * ret;
      const dpos = Math.abs(pos - positionsByTicker[t][i - 1]);
      if (dpos > 0) {
        const vol = (vols[t][i] != null && isFinite(vols[t][i])) ? vols[t][i] : 0.02;
        const c = dpos * (base + svm * vol);
        sret -= c; costPaid += c * (v[t] / (totalPrev || 1)); turns++;
      }
      const before = v[t];
      v[t] = before * (1 + sret);
      contrib[t] += (v[t] - before);
      wsum[t] += before / (totalPrev || 1);
    }
    if (isBoundary(dates[i - 1], dates[i], rebalance)) {
      let total = 0; for (const t of tickers) total += v[t];
      let rc = 0; for (const t of tickers) rc += Math.abs(weights[t] * total - v[t]) * base;
      total -= rc; costPaid += rc;
      for (const t of tickers) v[t] = weights[t] * total;
      rebalances++; rebalDates.push(dates[i]);
    }
    let tot = 0; for (const t of tickers) tot += v[t];
    equity[i] = tot;
    if (tot > peak) peak = tot;
    const d = peak > 0 ? 1 - tot / peak : 0; dd[i] = d; if (d > mdd) mdd = d;
  }

  const years = (ts[n - 1] - ts[0]) / (365.25 * 86400) || (n / 252);
  const cagr = years > 0 ? Math.pow(equity[n - 1], 1 / years) - 1 : 0;
  const calmar = mdd > 1e-9 ? cagr / mdd : (cagr > 0 ? Infinity : 0);
  const er = []; for (let i = 1; i < n; i++) er.push(equity[i] / equity[i - 1] - 1);
  let mean = 0; for (const x of er) mean += x; mean /= (er.length || 1);
  let variance = 0; for (const x of er) variance += (x - mean) ** 2; variance /= ((er.length - 1) || 1);
  const sd = Math.sqrt(variance);
  const sharpe = sd > 1e-12 ? mean / sd * Math.sqrt(252) : 0;

  const contribOut = {};
  for (const t of tickers) contribOut[t] = { pnl: contrib[t], avgWeight: wsum[t] / ((n - 1) || 1) };

  return {
    equity, drawdown: dd, dates, ts,
    metrics: { totalReturn: equity[n - 1] - 1, cagr, mdd, calmar, sharpe, years: +years.toFixed(2), bars: n, from: dates[0], to: dates[n - 1], turns, costPaid, rebalances },
    contrib: contribOut, rebalDates,
  };
}

// 자산곡선 하위구간 지표(OOS용) — a..b 렌ormalize.
export function metricsFromEquitySlice(equity, ts, a, b) {
  const e0 = equity[a] || 1;
  let peak = -Infinity, mdd = 0, last = 1;
  for (let i = a; i <= b; i++) { const x = equity[i] / e0; if (x > peak) peak = x; const d = 1 - x / peak; if (d > mdd) mdd = d; last = x; }
  const years = (ts[b] - ts[a]) / (365.25 * 86400) || ((b - a) / 252);
  const cagr = years > 0 ? Math.pow(last, 1 / years) - 1 : 0;
  const calmar = mdd > 1e-9 ? cagr / mdd : (cagr > 0 ? Infinity : 0);
  return { cagr, mdd, calmar };
}
