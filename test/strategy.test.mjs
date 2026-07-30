// 전략 DSL·비용 모델 픽스처 테스트 — 손으로 계산한 값과 대조.
import assert from 'node:assert';
import { evalRuleStrategy, positionsFor } from '../src/strategy.js';
import { runBacktest, buyHold } from '../src/backtest.js';

let pass = 0;
const t = (name, fn) => { try { fn(); console.log('  ok  ', name); pass++; } catch (e) { console.error('  FAIL', name, '—', e.message); process.exitCode = 1; } };
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, `${msg}\n  got: ${JSON.stringify(a)}\n  exp: ${JSON.stringify(b)}`);

// ── 상태형(long): 종가 > 2면 보유. 신호는 1봉 지연 체결. ──
t('상태형 long: price>2, 1봉 지연', () => {
  const closes = [1, 2, 3, 2, 1, 2, 3];
  // raw = [0,0,1,0,0,0,1] → lag → [0,0,0,1,0,0,0]
  const pos = evalRuleStrategy({ type: 'rule', long: { op: '>', left: { ind: 'price' }, right: 2 } }, closes);
  eq(pos, [0, 0, 0, 1, 0, 0, 0], '상태형 포지션');
});

// ── 이벤트형(entry/exit): 가격이 10 상향돌파 진입 → 하향돌파 청산 ──
t('이벤트형 cross_up 진입 / cross_down 청산', () => {
  const closes = [8, 9, 11, 12, 9, 8, 12];
  // 진입 i=2, 청산 i=4, 재진입 i=6 → raw=[0,0,1,1,0,0,1] → lag → [0,0,0,1,1,0,0]
  const spec = {
    type: 'rule',
    entry: { op: 'cross_up', left: { ind: 'price' }, right: 10 },
    exit: { op: 'cross_down', left: { ind: 'price' }, right: 10 },
  };
  eq(evalRuleStrategy(spec, closes), [0, 0, 0, 1, 1, 0, 0], '이벤트형 포지션');
});

// ── 엣지: 진입·청산이 같은 봉에 동시 참 → 평상시 진입 우선(플랫일 때) ──
t('같은 봉 진입·청산 겹침: 플랫이면 진입 우선, 보유면 청산', () => {
  const closes = [1, 1, 1, 1];
  const always = { op: '>', left: { ind: 'price' }, right: 0 }; // 항상 참
  const spec = { type: 'rule', entry: always, exit: always };
  // i0 플랫→진입(1), i1 보유→청산(0), i2 플랫→진입(1), i3 보유→청산(0)
  // raw=[1,0,1,0] → lag → [0,1,0,1]
  eq(evalRuleStrategy(spec, closes), [0, 1, 0, 1], '겹침 엣지 포지션');
});

// ── all/any 결합 ──
t('AND(all): price>2 그리고 price<4', () => {
  const closes = [1, 3, 5, 3, 1];
  const spec = { type: 'rule', long: { all: [
    { op: '>', left: { ind: 'price' }, right: 2 },
    { op: '<', left: { ind: 'price' }, right: 4 },
  ] } };
  // raw: [f, t(3), f(5), t(3), f] = [0,1,0,1,0] → lag → [0,0,1,0,1]
  eq(evalRuleStrategy(spec, closes), [0, 0, 1, 0, 1], 'AND 포지션');
});

// ── positionsFor가 rule 타입을 evalRuleStrategy로 위임 ──
t('positionsFor(rule) 위임 일치', () => {
  const closes = [1, 2, 3, 2, 1, 2, 3];
  const spec = { type: 'rule', long: { op: '>', left: { ind: 'price' }, right: 2 } };
  eq(positionsFor(spec, closes, null), evalRuleStrategy(spec, closes), '위임 결과');
});

// ── 비용 모델: 운용보수가 보유 구간 수익을 깎는다 ──
t('expenseRatio가 노출 구간 총수익을 낮춘다', () => {
  const bars = [];
  let px = 100;
  for (let i = 0; i < 400; i++) { bars.push({ t: i * 86400, iso: 'x', close: px }); px *= 1.005; }
  const noFee = buyHold(bars, { expenseRatio: 0 }).metrics.totalReturn;
  const withFee = buyHold(bars, { expenseRatio: 0.0095 }).metrics.totalReturn;
  assert(withFee < noFee, '보수 반영 시 총수익이 더 낮아야');
  // 현금 구간(포지션 0)에는 보수 미부과: 항상 현금이면 보수 무관.
  const cash = new Array(bars.length).fill(0);
  const a = runBacktest(bars, cash, { expenseRatio: 0 }).metrics.totalReturn;
  const b = runBacktest(bars, cash, { expenseRatio: 0.05 }).metrics.totalReturn;
  eq(a, b, '현금 구간엔 보수 미부과');
});

// ── 거래비용: 변동성 비례 슬리피지 ──
t('변동성 큰 종목이 회전당 비용을 더 낸다', () => {
  const mk = (amp) => { const b = []; let p = 100; for (let i = 0; i < 300; i++) { p *= 1 + amp * (i % 2 ? 1 : -1) + 0.001; b.push({ t: i * 86400, iso: 'x', close: p }); } return b; };
  const pos = new Array(300).fill(0).map((_, i) => (i % 20 < 10 ? 1 : 0)); // 규칙적 회전
  const lowVol = runBacktest(mk(0.003), pos, { halfSpreadBps: 2, slippageVolMult: 0.05 }).metrics;
  const highVol = runBacktest(mk(0.03), pos, { halfSpreadBps: 2, slippageVolMult: 0.05 }).metrics;
  assert(lowVol.turns === highVol.turns, '회전 수 동일');
  assert(highVol.avgTurnBps > lowVol.avgTurnBps, '고변동일수록 회전당 비용 큼');
});

t('슬리피지 계수 0이면 스프레드만 부과', () => {
  const b = []; let p = 100; for (let i = 0; i < 200; i++) { p *= 1.002 * (i % 2 ? 1.01 : 0.99); b.push({ t: i * 86400, iso: 'x', close: p }); }
  const pos = b.map((_, i) => (i % 10 < 5 ? 1 : 0));
  const m = runBacktest(b, pos, { halfSpreadBps: 3, slippageVolMult: 0 }).metrics;
  assert(Math.abs(m.avgTurnBps - 3) < 1e-6, `편도 ≈3bps (got ${m.avgTurnBps})`);
});

console.log(`\n${pass} passed`);
