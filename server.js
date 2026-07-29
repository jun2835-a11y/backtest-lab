// 백테스트 검증 랩 — Express 서버.
// 정적 프론트 서빙 + 자연어 파싱(/api/parse) + 프로토콜 실행(/api/backtest).

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseRequest } from './src/parse.js';
import { runProtocol } from './src/protocol.js';
import { TICKERS, UNIVERSE, REGIMES } from './src/data.js';
import { STRATEGY_TYPES } from './src/strategy.js';
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
    const spec = await parseRequest(nl);
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`backtest-lab → http://localhost:${PORT}`));
