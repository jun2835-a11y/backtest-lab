// 백테스트 검증 랩 — Express 서버.
// 정적 프론트 서빙 + 자연어 파싱(/api/parse) + 프로토콜 실행(/api/backtest).

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseRequest } from './src/parse.js';
import { runProtocol } from './src/protocol.js';
import { TICKERS, UNIVERSE, REGIMES, getFree } from './src/data.js';
import { STRATEGY_TYPES, normalizeSpec, positionsFor, gridFor } from './src/strategy.js';
import { runBacktest, buyHold } from './src/backtest.js';
import { PASS_RULES } from './src/protocol.js';
import { mulberry32, hashStr, bootstrapCalmarCI, timingShuffleControl, oosSplitIndex, equityToReturns } from './src/stats.js';

const APP_VERSION = 'backtest-lab 0.2.0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(join(__dirname, 'public')));

// 메타: 프론트가 유니버스·전략타입·판정규칙을 렌더할 수 있게.
app.get('/api/meta', (req, res) => {
  res.json({
    tickers: TICKERS,
    universe: UNIVERSE,
    regimes: REGIMES,
    strategyTypes: Object.fromEntries(
      Object.entries(STRATEGY_TYPES).map(([k, v]) => [k, { label: v.label, gridParam: v.gridParam, defaultGrid: v.defaultGrid }])
    ),
    passRules: Object.fromEntries(
      Object.entries(PASS_RULES).map(([k, v]) => [k, { label: v.label, desc: v.desc }])
    ),
    llm: !!process.env.ANTHROPIC_API_KEY,
  });
});

// 자연어 → 사전등록 스펙 초안.
app.post('/api/parse', async (req, res) => {
  try {
    const nl = String(req.body?.request || '').slice(0, 4000);
    if (!nl.trim()) return res.status(400).json({ error: '요청 문장이 비었습니다.' });
    const mode = req.body?.mode === 'pro' ? 'pro' : 'simple';
    const spec = await parseRequest(nl, mode);
    res.json({ ok: true, spec });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 사전등록 스펙 → 프로토콜 실행 → 판정.
app.post('/api/backtest', async (req, res) => {
  try {
    const preReg = req.body?.preReg;
    if (!preReg || !preReg.strategy) return res.status(400).json({ error: '사전등록 스펙이 필요합니다.' });
    const result = await runProtocol(preReg);
    res.json({ ok: true, result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 자유 모드: 임의 종목 × 전략 단순 백테스트 → 매수후보유 대비 칼마 우위로 QUANT 판정.
app.post('/api/simple', async (req, res) => {
  try {
    const body = req.body || {};
    const tickers = (body.tickers || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean).slice(0, 12);
    if (!tickers.length) return res.status(400).json({ error: '종목을 하나 이상 입력하세요.' });

    const inSpec = body.strategy || { type: 'ma_timing', maType: 'sma' };
    let spec, chosen = null, label;
    if (inSpec.type === 'rule') {
      spec = inSpec;                                   // 조립식 규칙: 그대로 해석
      label = inSpec.label || '커스텀 규칙';
    } else {
      spec = normalizeSpec(inSpec);
      const g = gridFor(spec);
      chosen = inSpec.chosenParam ?? spec.chosenParam ?? g.grid[Math.floor(g.grid.length / 2)];
      spec.chosenParam = chosen;
      label = ({ ma_timing: `MA·${chosen}`, dual_ma: `골든크로스·${chosen}`, vol_target: `변동성·${chosen}` })[spec.type] || spec.type;
    }

    const to = body.to || new Date().toISOString().slice(0, 10);
    const from = body.from || `${new Date().getUTCFullYear() - 10}-01-01`;

    const BOOT = 300, CONTROL = 200;
    // 거래비용 모델: 스프레드 + 변동성비례 슬리피지(레버리지 ETF 현실화).
    const costOpts = { commissionBps: 0, halfSpreadBps: 2, slippageVolMult: 0.05, volWindow: 20 };

    // 벤치마크: self(자기 매수후보유) / spy(SPY 보유) / cash(현금 0%).
    let benchKind = ['self', 'spy', 'cash'].includes(body.benchmark) ? body.benchmark : 'self';
    let benchLabel = { self: '자기 매수후보유', spy: 'SPY 보유', cash: '현금 0%' }[benchKind];
    let spyFull = null, spyTest = null, benchNote = '';
    if (benchKind === 'spy') {
      try {
        const { bars: sb } = await getFree('SPY', from, to);
        if (sb && sb.length >= 120) {
          spyFull = buyHold(sb, costOpts).metrics;
          spyTest = buyHold(sb.slice(oosSplitIndex(sb.length, 0.6)), costOpts).metrics;
        } else throw new Error('SPY 데이터 부족');
      } catch (e) { benchKind = 'self'; benchLabel = '자기 매수후보유'; benchNote = 'SPY 벤치마크 조회 실패 → 자기 매수후보유로 대체'; }
    }
    const cashMetrics = { calmar: 0, cagr: 0, mdd: 0, sharpe: 0, exposure: 0, totalReturn: 0 };

    const rows = [];
    for (const t of tickers) {
      try {
        const { name, bars } = await getFree(t, from, to);
        if (!bars || bars.length < 120) { rows.push({ ticker: t, name, error: '데이터 부족(통계 검정에 최소 ~120봉 필요)' }); continue; }
        const closes = bars.map((b) => b.close);
        const pos = positionsFor(spec, closes, chosen);
        const run = runBacktest(bars, pos, costOpts);
        const strat = run.metrics;
        const bhRun = buyHold(bars, costOpts);
        const bh = bhRun.metrics;

        // 재현성: 종목+스펙+기간으로 시드 고정.
        const rng = mulberry32(hashStr(`${t}|${JSON.stringify(spec)}|${from}|${to}`));

        // OOS 분리: 앞 60% train, 뒤 40% test (같은 포지션 규칙, 룩어헤드 없음).
        const k = oosSplitIndex(bars.length, 0.6);
        const trainStrat = runBacktest(bars.slice(0, k), pos.slice(0, k), costOpts).metrics;
        const trainBH = buyHold(bars.slice(0, k), costOpts).metrics;
        const testStrat = runBacktest(bars.slice(k), pos.slice(k), costOpts).metrics;
        const testBH = buyHold(bars.slice(k), costOpts).metrics;

        // 블록 부트스트랩 칼마 신뢰구간.
        const calmarCI = bootstrapCalmarCI(equityToReturns(run.equity), { block: 20, iters: BOOT, rng });
        // 타이밍 셔플 랜덤대조(같은 비용 모델).
        const control = timingShuffleControl(bars, pos, strat.calmar, { iters: CONTROL, rng, opts: costOpts });

        // 판정 기준 벤치마크 선택.
        const bench = benchKind === 'spy' ? spyFull : benchKind === 'cash' ? cashMetrics : bh;
        const benchT = benchKind === 'spy' ? spyTest : benchKind === 'cash' ? cashMetrics : testBH;

        // 다차원 신뢰: 베이스 우위 + (OOS 유지 / 랜덤 초과 / CI 양수) 확증 수.
        const baseBeat = strat.calmar > bench.calmar;
        const oosBeat = testStrat.calmar > benchT.calmar;
        const vsRandom = control ? control.percentile >= 0.90 : false;
        const ciPositive = calmarCI ? calmarCI.lo > 0 : false;
        const corrob = [oosBeat, vsRandom, ciPositive].filter(Boolean).length;
        const denom = Math.abs(bench.calmar) > 1e-9 ? Math.abs(bench.calmar) : 1;
        const nearTie = Math.abs((strat.calmar - bench.calmar) / denom) <= 0.10;

        let state, label2;
        if (!baseBeat) { state = 'cut'; label2 = 'NOT-QUANT'; }
        else if (nearTie) { state = 'push'; label2 = 'PUSH'; }
        else if (corrob >= 2) { state = 'quant'; label2 = 'QUANT'; }
        else { state = 'weak'; label2 = 'QUANT?'; } // 베이스만 이기고 확증 부족

        // 자산곡선 + 낙폭 차트용 다운샘플(~160점).
        const N = bars.length, stride = Math.max(1, Math.floor(N / 160));
        const pts = [];
        for (let i = 0; i < N; i += stride) pts.push({ i, s: run.equity[i], b: bhRun.equity[i], d: run.drawdown[i] });
        if (pts[pts.length - 1].i !== N - 1) pts.push({ i: N - 1, s: run.equity[N - 1], b: bhRun.equity[N - 1], d: run.drawdown[N - 1] });
        // 매수(진입)·매도(청산) 시점 — 포지션 변경일. 신호 T+1 집행이므로 그 봉의 iso 표기.
        const trades = [];
        for (let i = 1; i < N; i++) {
          if (pos[i] !== pos[i - 1]) trades.push({ i, type: pos[i] > pos[i - 1] ? 'buy' : 'sell', eq: run.equity[i], iso: bars[i].iso });
        }

        rows.push({
          ticker: t, name, strat, bh,
          bench: benchKind === 'self' ? null : { kind: benchKind, label: benchLabel, calmar: bench.calmar, cagr: bench.cagr, mdd: bench.mdd },
          verdict: { state, label: label2 },
          oos: { split: bars[k].iso, splitIdx: k, train: { strat: trainStrat, bh: trainBH }, test: { strat: testStrat, bh: testBH } },
          calmarCI, control,
          checks: { baseBeat, oosBeat, vsRandom, ciPositive, corrob },
          chart: { pts, n: N, from: bars[0].iso, to: bars[N - 1].iso, trades },
        });
      } catch (e) {
        rows.push({ ticker: t, error: String(e.message || e).slice(0, 100) });
      }
    }
    const counts = { quant: 0, weak: 0, push: 0, cut: 0 };
    rows.forEach((r) => { if (r.verdict) counts[r.verdict.state]++; });
    const runCard = {
      version: APP_VERSION,
      ranAt: new Date().toISOString(),
      dataSource: 'Yahoo Finance 조정종가(net-of-fee)',
      costModel: costOpts,
      iters: { bootstrap: BOOT, control: CONTROL, oosTrainFrac: 0.6 },
      execution: 'T+1 · 100% 또는 현금',
      benchmark: benchLabel,
    };
    res.json({ ok: true, result: { rows, summary: { counts, total: rows.length }, spec: { type: spec.type, label, chosenParam: chosen }, from, to, runCard, benchmark: { kind: benchKind, label: benchLabel, note: benchNote } } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`backtest-lab → http://localhost:${PORT}`));
