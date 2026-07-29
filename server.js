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

    const rows = [];
    for (const t of tickers) {
      try {
        const { name, bars } = await getFree(t, from, to);
        if (!bars || bars.length < 40) { rows.push({ ticker: t, name, error: '데이터 부족(상장 이력이 짧거나 없음)' }); continue; }
        const closes = bars.map((b) => b.close);
        const pos = positionsFor(spec, closes, chosen);
        const strat = runBacktest(bars, pos).metrics;
        const bh = buyHold(bars).metrics;
        const pass = strat.calmar > bh.calmar;
        rows.push({ ticker: t, name, pass, strat, bh });
      } catch (e) {
        rows.push({ ticker: t, error: String(e.message || e).slice(0, 100) });
      }
    }
    const quant = rows.filter((r) => r.pass).length;
    res.json({ ok: true, result: { rows, summary: { quant, total: rows.length }, spec: { type: spec.type, label, chosenParam: chosen }, from, to } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`backtest-lab → http://localhost:${PORT}`));
