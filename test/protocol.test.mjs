// 순수 로직 테스트 (네트워크 없이): 백테스트 지표 + 평원 검사 산술.
import assert from 'node:assert';
import { runBacktest, buyHold } from '../src/backtest.js';
import { sma } from '../src/indicators.js';

let pass = 0;
const t = (name, fn) => { try { fn(); console.log('  ok  ', name); pass++; } catch (e) { console.error('  FAIL', name, '—', e.message); process.exitCode = 1; } };

// 합성 봉: 매일 +1% 상승.
const bars = [];
let px = 100;
for (let i = 0; i < 300; i++) { bars.push({ t: i * 86400, iso: '2020-01-01', close: px }); px *= 1.01; }

t('buyHold: 상승장에서 양의 CAGR·총수익', () => {
  const m = buyHold(bars).metrics;
  assert(m.totalReturn > 0, 'totalReturn>0');
  assert(m.cagr > 0, 'cagr>0');
  assert(m.mdd < 0.02, 'mdd 작음(단조상승)');
});

t('SMA: 기간만큼 null 프리픽스', () => {
  const s = sma(bars.map((b) => b.close), 10);
  assert(s[8] === null && s[9] !== null, 'warmup 경계');
});

t('풀노출 백테스트 = buyHold(비용 없을 때)', () => {
  const pos = new Array(bars.length).fill(1);
  const a = runBacktest(bars, pos).metrics;
  const b = buyHold(bars).metrics;
  assert(Math.abs(a.totalReturn - b.totalReturn) < 1e-9, '동일');
});

t('칼마 = CAGR / MDD (양수 구간)', () => {
  const mixed = [];
  let p = 100;
  for (let i = 0; i < 500; i++) { p *= (1 + (Math.sin(i / 20) * 0.02)); mixed.push({ t: i * 86400, iso: 'x', close: p }); }
  const m = buyHold(mixed).metrics;
  if (m.mdd > 1e-6 && isFinite(m.calmar)) assert(Math.abs(m.calmar - m.cagr / m.mdd) < 1e-6, 'calmar 정의');
});

console.log(`\n${pass} passed`);
