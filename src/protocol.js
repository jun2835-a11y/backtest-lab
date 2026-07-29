// 검증 프로토콜 — 이 프로젝트의 심장.
// 사전등록 → 이중 관문 → 평원 → 다종목 → 상설 판정원칙을 그대로 코드로 강제한다.
//
// 원칙(사용자 정의):
//  · 사전등록: 그리드·관문 통과선·평원 임계·과반을 돌리기 전에 잠근다. 돌린 뒤 변경 = 과적합.
//  · 이중 관문: ① QE 실데이터(전·후반 분할) 무훼손 AND ② 잃어버린 10년(3배 합성) 무훼손. 한쪽만은 기각.
//  · 평원: 그리드에서 고립 피크 기각, 선택값은 평원(이웃 안정) 안이어야.
//  · 다종목: 5종목 중 threshold(기본 3) 이상 통과해야 채택. 2종목은 근거 안 됨.
//  · 판정: 칼마 10%내면 수익 우선 / 동급이면 단순한 쪽.

import { getSeries, TICKERS } from './data.js';
import { positionsFor, gridFor, normalizeSpec } from './strategy.js';
import { runBacktest, buyHold } from './backtest.js';

// "무훼손" 판정 규칙 카탈로그 — 사전등록에서 하나를 잠근다.
export const PASS_RULES = {
  mdd_and_calmar: {
    label: 'MDD 축소 + 칼마 비열위 (기본)',
    test: (s, bh) => s.mdd <= bh.mdd + 1e-9 && s.calmar >= bh.calmar - 1e-9,
    desc: '전략 MDD가 매수후보유보다 크지 않고, 칼마가 열위가 아님',
  },
  beat_bh_calmar: {
    label: '칼마 초과 (마진 적용)',
    test: (s, bh, m = 0) => s.calmar >= bh.calmar * (1 + m),
    desc: '전략 칼마가 매수후보유 칼마의 (1+마진) 이상',
  },
  positive_calmar: {
    label: '양의 칼마 + 양의 CAGR',
    test: (s) => s.calmar > 0 && s.cagr > 0,
    desc: '절대 기준: 칼마·CAGR 모두 양수',
  },
};

// 기본 사전등록 초안 — LLM/폼이 이 위에 덮어쓴다.
export function defaultPreReg(spec) {
  const g = gridFor(spec);
  const mid = g.grid[Math.floor(g.grid.length / 2)];
  return {
    strategy: normalizeSpec(spec),
    chosenParam: spec.chosenParam ?? mid, // 평원 중간 후보
    passRule: 'mdd_and_calmar',
    passMargin: 0,
    plateau: { neighborhood: 1, tolerance: 0.15 }, // 이웃 ±1, 피크의 85% 이상이면 평원
    multiTicker: { threshold: 3 },
    principle: { calmarBand: 0.10 }, // 칼마 10%내면 수익 우선
  };
}

function evalRule(preReg, s, bh) {
  const rule = PASS_RULES[preReg.passRule] || PASS_RULES.mdd_and_calmar;
  return rule.test(s, bh, preReg.passMargin || 0);
}

// 한 종목·한 리짐에서 그리드 전체를 훑어 파라미터별 지표 표를 만든다.
async function sweep(ticker, regimeKey, preReg) {
  const spec = preReg.strategy;
  const series = await getSeries(ticker, regimeKey);
  const bars = series.bars;
  const closes = bars.map((b) => b.close);
  const bh = buyHold(bars).metrics;
  const rows = spec.grid.map((p) => {
    const pos = positionsFor(spec, closes, p);
    const m = runBacktest(bars, pos).metrics;
    return { param: p, ...m, pass: evalRule(preReg, m, bh) };
  });
  return { ticker, regime: regimeKey, label: series.label, source: series.source, bh, rows, bars: bars.length };
}

// 평원 검사: 선택 파라미터가 고립 피크가 아니라 이웃이 안정적인 평원 안에 있는가.
function plateauCheck(rows, chosenParam, cfg) {
  const idx = rows.findIndex((r) => r.param === chosenParam);
  if (idx < 0) {
    return { pass: false, reason: `선택값 ${chosenParam}이(가) 그리드에 없음`, chosenCalmar: null, neighbors: [] };
  }
  const chosen = rows[idx];
  const k = cfg.neighborhood ?? 1;
  const tol = cfg.tolerance ?? 0.15;
  const neighbors = [];
  let ok = true;
  for (let d = -k; d <= k; d++) {
    if (d === 0) continue;
    const j = idx + d;
    if (j < 0 || j >= rows.length) continue;
    const nb = rows[j];
    // 이웃 칼마가 선택값 칼마의 (1-tol) 이상이면 안정.
    const floor = chosen.calmar >= 0 ? chosen.calmar * (1 - tol) : chosen.calmar * (1 + tol);
    const stable = nb.calmar >= floor;
    neighbors.push({ param: nb.param, calmar: nb.calmar, stable });
    if (!stable) ok = false;
  }
  // 고립 피크 여부: 선택값이 이웃보다 압도적으로 높으면(이웃이 붕괴) 피크.
  return {
    pass: ok && neighbors.length > 0,
    chosenParam,
    chosenCalmar: chosen.calmar,
    neighbors,
    reason: ok ? '이웃 안정(평원)' : '이웃 붕괴(고립 피크 의심)',
  };
}

// 종목 하나에 대한 이중 관문 + 평원 종합.
async function evaluateTicker(ticker, preReg) {
  const [qeFirst, qeSecond, qeFull, lost] = await Promise.all([
    sweep(ticker, 'qe_first', preReg),
    sweep(ticker, 'qe_second', preReg),
    sweep(ticker, 'qe_full', preReg),
    sweep(ticker, 'lost', preReg),
  ]);

  const at = (swp) => swp.rows.find((r) => r.param === preReg.chosenParam) || null;
  const g1First = at(qeFirst), g1Second = at(qeSecond), g2 = at(lost);

  // 관문①: QE 전·후반 모두 무훼손.
  const gate1Pass = !!(g1First?.pass && g1Second?.pass);
  // 관문②: 잃어버린 10년 무훼손.
  const gate2Pass = !!(g2?.pass);
  // 이중 관문: 둘 다.
  const dualGatePass = gate1Pass && gate2Pass;

  // 평원: 주표본(QE 전체)에서 고립 피크 아님.
  const plateau = plateauCheck(qeFull.rows, preReg.chosenParam, preReg.plateau || {});

  const tickerPass = dualGatePass && plateau.pass;

  return {
    ticker,
    chosenParam: preReg.chosenParam,
    gate1: {
      pass: gate1Pass,
      qe_first: g1First && { pass: g1First.pass, metrics: g1First, bh: qeFirst.bh },
      qe_second: g1Second && { pass: g1Second.pass, metrics: g1Second, bh: qeSecond.bh },
    },
    gate2: {
      pass: gate2Pass,
      lost: g2 && { pass: g2.pass, metrics: g2, bh: lost.bh },
    },
    dualGatePass,
    plateau,
    tickerPass,
    // 그리드 표면(QE 전체) — 프론트 차트용.
    surface: qeFull.rows.map((r) => ({ param: r.param, calmar: r.calmar, cagr: r.cagr, mdd: r.mdd, pass: r.pass })),
    surfaceBH: qeFull.bh,
  };
}

// 전체 프로토콜 실행.
export async function runProtocol(preRegIn) {
  const preReg = { ...defaultPreReg(preRegIn.strategy || preRegIn), ...preRegIn };
  preReg.strategy = normalizeSpec(preReg.strategy || preRegIn.strategy || preRegIn);

  const universe = preReg.tickers && preReg.tickers.length ? preReg.tickers : TICKERS;
  const perTicker = [];
  for (const t of universe) {
    try {
      perTicker.push(await evaluateTicker(t, preReg));
    } catch (e) {
      perTicker.push({ ticker: t, error: String(e.message || e), tickerPass: false });
    }
  }

  const passing = perTicker.filter((r) => r.tickerPass).map((r) => r.ticker);
  const threshold = preReg.multiTicker?.threshold ?? 3;
  const adopt = passing.length >= threshold;

  // 상설 판정원칙 적용: 채택 시 통과 종목 중 대표 파라미터 성능 비교(칼마 10%내면 수익 우선).
  const reasons = [];
  reasons.push(`이중 관문 통과 종목 ${passing.length}/${universe.length} — 기준 ${threshold} 이상 ${adopt ? '충족' : '미달'}`);
  if (!adopt && passing.length === 2) {
    reasons.push('2종목 통과는 채택 근거가 못 된다(F126·㉜가 여기서 죽음).');
  }
  const failReasons = perTicker.filter((r) => !r.tickerPass).map((r) => {
    if (r.error) return `${r.ticker}: 오류(${r.error})`;
    const why = [];
    if (!r.gate1?.pass) why.push('관문①(QE) 훼손');
    if (!r.gate2?.pass) why.push('관문②(잃10) 훼손');
    if (r.plateau && !r.plateau.pass) why.push('평원 실패(고립 피크)');
    return `${r.ticker}: ${why.join(', ') || '미상'}`;
  });

  // 재심 조건 명시.
  const retrial = [];
  if (!adopt) {
    retrial.push('새 표본(추가 리짐·기간)이 확보되면 재심.');
    retrial.push('통과선(passRule)·평원 임계는 사전등록 값 고정 — 사후 완화 금지.');
  }

  return {
    preReg,
    universe,
    perTicker,
    multiTicker: { passing, count: passing.length, threshold },
    verdict: {
      decision: adopt ? '채택' : '기각',
      reasons,
      failReasons,
      retrial,
      principleNote: '동급 비교 시: 칼마 10%내면 수익 우선, 그래도 동급이면 단순한 쪽.',
    },
  };
}
