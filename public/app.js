// 백테스트 검증 콘솔 — 클라이언트.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

let META = null;
let SPEC = null;      // 파싱된/편집중 스펙
let SEALED = null;    // 사전등록 봉인 스냅샷
let hasResult = false;

const EXAMPLES = [
  'TQQQ·SOXL·UPRO·TNA·LABU에 200일 이동평균 타이밍. 5종목 중 3개 통과해야 채택.',
  '50/200 이중 이동평균 골든크로스 전략, 지수이동평균으로.',
  '20일 롤링 변동성이 임계 아래일 때만 보유하는 변동성 관문 전략.',
  'TQQQ에 220일선 타이밍, 평원 임계 느슨하게.',
];

const fmtPct = (x) => (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(1) + '%';
const fmtR = (x) => x == null ? '—' : (!isFinite(x) ? '∞' : x.toFixed(2));

// ── 부팅 ──
async function boot() {
  META = await (await fetch('/api/meta')).json();

  const ex = $('#examples');
  EXAMPLES.forEach((t) => {
    const c = el('span', 'ex', t.length > 42 ? t.slice(0, 42) + '…' : t);
    c.title = t;
    c.onclick = () => { $('#request').value = t; };
    ex.appendChild(c);
  });
  setStep(0);
  initSimpleMode();
}

// ── 모드 전환 + 간편 모드 ──
function initSimpleMode() {
  // 모드 토글
  $$('.mode-switch .ms').forEach((b) => {
    b.onclick = () => {
      $$('.mode-switch .ms').forEach((x) => x.classList.toggle('active', x === b));
      const mode = b.dataset.mode;
      $('#mode-simple').classList.toggle('hidden', mode !== 'simple');
      $('#mode-portfolio').classList.toggle('hidden', mode !== 'portfolio');
      $('#mode-pro').classList.toggle('hidden', mode !== 'pro');
    };
  });

  // 전략은 자연어 입력만 사용 — 해석 → 확인 → 실행
  $('#s-run').onclick = runSimple;
  $('#pf-run').onclick = runPortfolio;
  $('#s-confirm-run').onclick = () => {
    if (!PENDING) return;
    $('#s-confirm-panel').classList.add('hidden');
    saveSpec(PENDING);
    runWith(PENDING.tickers, PENDING.strategy, PENDING.from, PENDING.to, PENDING.benchmark, PENDING.exec);
  };
  $('#s-confirm-cancel').onclick = () => $('#s-confirm-panel').classList.add('hidden');

  // 지난 스펙 재실행(재현성): LLM 재해석 없이 저장된 JSON 그대로.
  const saved = loadSpec();
  if (saved) {
    const b = $('#s-rerun');
    b.classList.remove('hidden');
    b.onclick = () => { PENDING = saved; runWith(saved.tickers, saved.strategy, saved.from, saved.to, saved.benchmark, saved.exec); };
  }
}

// ── 스펙 저장/로드(재현성) ──
function saveSpec(p) { try { localStorage.setItem('bt_last_spec', JSON.stringify(p)); } catch (e) {} }
function loadSpec() { try { return JSON.parse(localStorage.getItem('bt_last_spec')); } catch (e) { return null; } }

// ── 실행 히스토리(이전 결과와 비교) ──
const VRANK = { quant: 3, weak: 2, push: 1, cut: 0, err: -1 };
function loadHistory() { try { return JSON.parse(localStorage.getItem('bt_history') || '[]'); } catch (e) { return []; } }
function saveHistory(h) { try { localStorage.setItem('bt_history', JSON.stringify(h.slice(-12))); } catch (e) {} }
function buildHistoryEntry(res, input) {
  const byTicker = {};
  for (const r of res.rows) { if (r.error) continue; byTicker[r.ticker] = { v: r.verdict.state, label: r.verdict.label, calmar: r.strat.calmar, cagr: r.strat.cagr, mdd: r.strat.mdd }; }
  return { ts: Date.now(), at: new Date().toISOString().slice(0, 16).replace('T', ' '), label: res.spec.label || res.spec.type, from: res.from, to: res.to, benchmark: input?.benchmark || 'self', byTicker };
}
function updateCompare(currentRows, priors, selectedTs) {
  const box = document.getElementById('cmp-table');
  if (!box) return;
  if (selectedTs === 'none') { box.innerHTML = '<div class="cmp-none">비교하지 않음</div>'; return; }
  const base = priors.find((p) => String(p.ts) === String(selectedTs)) || priors[priors.length - 1];
  const rows = currentRows.filter((r) => !r.error);
  let html = `<div class="cmp-meta">기준: <b>${base.label}</b> · ${base.at} · ${base.from}~${base.to} · ${BENCH_KO[base.benchmark] || '자기 매수후보유'}</div>
    <table class="cmp-table"><thead><tr><th>Ticker</th><th>기준 판정(칼마)</th><th>현재 판정(칼마)</th><th>Δ칼마</th><th>변화</th></tr></thead><tbody>`;
  for (const r of rows) {
    const b = base.byTicker[r.ticker];
    if (!b) { html += `<tr><td>${r.ticker}</td><td class="muted">—</td><td>${r.verdict.label} (${fmtR(r.strat.calmar)})</td><td>—</td><td class="new">신규</td></tr>`; continue; }
    const d = r.strat.calmar - b.calmar;
    const dTxt = isFinite(d) ? (d >= 0 ? '+' : '') + d.toFixed(2) : '∞';
    const rankUp = (VRANK[r.verdict.state] ?? 0) - (VRANK[b.v] ?? 0);
    const arrow = rankUp > 0 ? '<span class="up">▲ 개선</span>' : rankUp < 0 ? '<span class="down">▼ 악화</span>' : (isFinite(d) && Math.abs(d) < 0.01 ? '<span class="same">= 동일</span>' : (d > 0 ? '<span class="up">▲</span>' : '<span class="down">▼</span>'));
    html += `<tr><td>${r.ticker}</td><td class="muted">${b.label} (${fmtR(b.calmar)})</td><td>${r.verdict.label} (${fmtR(r.strat.calmar)})</td><td class="${d >= 0 ? 'up' : 'down'}">${dTxt}</td><td>${arrow}</td></tr>`;
  }
  html += '</tbody></table>';
  box.innerHTML = html;
}

// ── 내보내기: CSV·JSON·공유 링크 ──
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function exportCSV(res) {
  const head = ['ticker', 'name', 'verdict', 'strat_cagr', 'strat_mdd', 'strat_calmar', 'strat_sharpe', 'exposure', 'bh_calmar', 'bench_calmar', 'oos_test_strat_calmar', 'oos_test_bh_calmar', 'calmarCI_lo', 'calmarCI_hi', 'random_pctile', 'corrob', 'turns', 'avgTurnBps', 'costPaid_pct'];
  const lines = [head.join(',')];
  for (const r of res.rows) {
    if (r.error) { lines.push([r.ticker, r.name, 'ERROR:' + r.error].map(csvCell).join(',')); continue; }
    const row = [r.ticker, r.name, r.verdict.label, r.strat.cagr, r.strat.mdd, r.strat.calmar, r.strat.sharpe, r.strat.exposure,
      r.bh.calmar, r.bench ? r.bench.calmar : r.bh.calmar, r.oos.test.strat.calmar, r.oos.test.bh.calmar,
      r.calmarCI ? r.calmarCI.lo : '', r.calmarCI ? r.calmarCI.hi : '', r.control ? r.control.percentile : '',
      r.checks.corrob, r.strat.turns, r.strat.avgTurnBps, r.strat.costPaid * 100];
    lines.push(row.map(csvCell).join(','));
  }
  download(`backtest_${res.from}_${res.to}.csv`, '﻿' + lines.join('\n'), 'text/csv;charset=utf-8');
}
function exportJSON() {
  if (!LAST_RESULT) return;
  download(`backtest_${LAST_RESULT.input.from}_${LAST_RESULT.input.to}.json`, JSON.stringify(LAST_RESULT, null, 2), 'application/json');
}
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(str) { return decodeURIComponent(escape(atob(str))); }
function exportShare() {
  if (!LAST_RESULT) return;
  const code = b64encode(JSON.stringify(LAST_RESULT.input));
  const url = `${location.origin}${location.pathname}#run=${code}`;
  const st = $('#exp-status');
  navigator.clipboard?.writeText(url).then(() => { if (st) st.textContent = '링크 복사됨 ✓ (열면 동일 입력으로 재실행)'; },
    () => { if (st) st.innerHTML = `<input value="${url}" readonly style="width:60%">`; });
}
// 공유 링크로 열렸을 때 동일 입력 재실행.
function tryShareLink() {
  const pf = (location.hash || '').match(/pf=([^&]+)/);
  if (pf) {
    try {
      const input = JSON.parse(b64decode(pf[1]));
      $('.mode-switch .ms[data-mode="portfolio"]').click();
      if (input.tickers) $('#pf-tickers').value = input.tickers.join(', ');
      $('#pf-nl').value = input.strategy?.label || '(공유된 스펙)';
      if (input.allocation) $('#pf-alloc').value = input.allocation;
      if (input.rebalance) $('#pf-rebal').value = input.rebalance;
      if (input.benchmark) $('#pf-benchmark').value = input.benchmark;
      // 스펙을 직접 실행(재해석 없이): parse 우회 위해 임시로 payload 구성
      runPortfolioWith(input);
      return true;
    } catch (e) { return false; }
  }
  const m = (location.hash || '').match(/run=([^&]+)/);
  if (!m) return false;
  try {
    const input = JSON.parse(b64decode(m[1]));
    $('.mode-switch .ms[data-mode="simple"]').click();
    if (input.tickers) $('#s-tickers').value = input.tickers.join(', ');
    if (input.benchmark) $('#s-benchmark').value = input.benchmark;
    $('#s-nl').value = input.strategy?.label || '(공유된 스펙 실행)';
    PENDING = { strategy: input.strategy, tickers: input.tickers, from: input.from, to: input.to, benchmark: input.benchmark };
    runWith(input.tickers, input.strategy, input.from, input.to, input.benchmark);
    return true;
  } catch (e) { return false; }
}

// 기간 프리셋 → from/to
function periodRange() {
  const v = $('#s-period').value;
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  if (v === 'max') return { from: '2000-01-01', to };
  const y = parseInt(v, 10);
  const f = new Date(Date.UTC(today.getUTCFullYear() - y, today.getUTCMonth(), today.getUTCDate()));
  return { from: f.toISOString().slice(0, 10), to };
}

// 자연어 → 스펙 해석 (/api/parse). 종목 자동 인식 시 폼 채움.
async function parseNL(nl) {
  const r = await (await fetch('/api/parse', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request: nl, mode: 'simple' }),
  })).json();
  if (!r.ok) throw new Error(r.error || '해석 실패');
  SPEC = r.spec;
  if (r.spec.tickers && r.spec.tickers.length && r.spec.tickers.length <= 12 && !$('#s-tickers').value.trim())
    $('#s-tickers').value = r.spec.tickers.join(', ');
  return r.spec;
}

let PENDING = null; // 해석 확인 대기 스펙

// 해석 → 확인 단계(실행 전 승인)
async function runSimple() {
  const nl = $('#s-nl').value.trim();
  if (!nl) { $('#s-status').innerHTML = '<span class="err">전략을 자연어로 입력하세요.</span>'; return; }
  const typed = $('#s-tickers').value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  const { from, to } = periodRange();
  $('#s-status').innerHTML = '<span class="loading"><span class="spinner"></span>전략 해석 중…</span>';
  let spec;
  try { spec = await parseNL(nl); } catch (e) { $('#s-status').innerHTML = `<span class="err">해석 오류: ${e.message}</span>`; return; }
  $('#s-status').innerHTML = '';
  const tk = $('#s-tickers').value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  const tickers = tk.length ? tk : typed;
  if (!tickers.length) { $('#s-status').innerHTML = '<span class="err">종목을 입력하세요. (또는 문장에 종목 포함)</span>'; return; }
  const benchmark = $('#s-benchmark').value;
  const exec = readExec();
  PENDING = { strategy: spec.strategy, tickers, from, to, benchmark, exec, notes: spec.notes, engine: spec.engine, downgraded: spec.downgraded, downgradeNote: spec.downgradeNote };
  renderConfirm(PENDING);
}
const BENCH_KO = { self: '자기 매수후보유', spy: 'SPY 보유', cash: '현금 (0%)' };
const SIZING_KO = { full: '전량(100%)', half: '절반(50%)', volTarget: '변동성 타겟' };
function readExec() {
  const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : 0; };
  const e = { stopLoss: num('#s-stop'), takeProfit: num('#s-tp'), trailingStop: num('#s-trail'), sizing: $('#s-sizing').value };
  return e;
}
function execActiveC(e) { return e && (e.stopLoss || e.takeProfit || e.trailingStop || (e.sizing && e.sizing !== 'full')); }
function descExec(e) {
  if (!execActiveC(e)) return '손절·익절·트레일링 없음 · 사이징 전량(100%)';
  return `손절 ${e.stopLoss ? e.stopLoss + '%' : '없음'} · 익절 ${e.takeProfit ? e.takeProfit + '%' : '없음'} · 트레일링 ${e.trailingStop ? e.trailingStop + '%' : '없음'} · 사이징 ${SIZING_KO[e.sizing] || e.sizing}`;
}

// ── 스펙을 사람이 읽는 말로 ──
const OP_KO = { '>': '초과', '<': '미만', '>=': '이상', '<=': '이하', '==': '같음', 'cross_up': '상향돌파', 'cross_down': '하향돌파' };
function descOperand(op) {
  if (typeof op === 'number') return String(op);
  if (op == null) return '?';
  if (op.const != null) return String(op.const);
  const p = op.period || op.p;
  switch ((op.ind || op.indicator || 'price').toLowerCase()) {
    case 'price': case 'close': return '종가';
    case 'sma': return `${p || 50}일 이동평균`;
    case 'ema': return `${p || 50}일 지수이평`;
    case 'rsi': return `RSI(${p || 14})`;
    case 'roc': case 'momentum': return `${p || 20}일 모멘텀`;
    case 'vol': case 'volatility': return `${p || 20}일 변동성`;
    case 'high': return `${p || 20}일 최고`;
    case 'low': return `${p || 20}일 최저`;
    case 'macd': return `MACD ${op.line || 'line'}`;
    case 'bb': case 'bollinger': return `볼린저 ${op.band || 'mid'}(${p || 20},${op.mult || 2})`;
    default: return '종가';
  }
}
function descCond(c) {
  if (!c || typeof c !== 'object') return '?';
  if (Array.isArray(c.all)) return '(' + c.all.map(descCond).join(' 그리고 ') + ')';
  if (Array.isArray(c.any)) return '(' + c.any.map(descCond).join(' 또는 ') + ')';
  if (c.not) return 'NOT ' + descCond(c.not);
  if (c.op) return `${descOperand(c.left)} ${OP_KO[c.op] || c.op} ${descOperand(c.right)}`;
  return '?';
}
function descStrategy(s) {
  if (s.type === 'ma_timing') return `종가가 <b>${s.chosenParam}일 ${(s.maType || 'sma').toUpperCase()}</b> 위일 때 100% 보유, 아래면 현금`;
  if (s.type === 'dual_ma') return `<b>${s.fast || 50}일 MA</b>가 <b>${s.chosenParam}일 MA</b> 위일 때 보유, 아니면 현금`;
  if (s.type === 'vol_target') return `<b>${s.window || 20}일 변동성</b>이 <b>${s.chosenParam}</b> 미만일 때 보유, 아니면 현금`;
  if (s.type === 'rule') {
    if (s.entry || s.exit) return `진입: <b>${descCond(s.entry)}</b> → 청산: <b>${descCond(s.exit)}</b> (사이 구간 보유)`;
    return `<b>${descCond(s.long || s.rule || s.condition)}</b> 인 구간만 보유, 아니면 현금`;
  }
  return JSON.stringify(s);
}

function renderConfirm(p) {
  $('#s-result-panel').classList.add('hidden');
  const panel = $('#s-confirm-panel');
  panel.classList.remove('hidden');
  const dg = p.downgraded ? `<div class="downgrade-banner">⚠ ${p.downgradeNote || '요청을 해석하지 못해 기본 전략으로 대체했습니다.'}</div>` : '';
  const engineTag = p.engine === 'llm' ? 'Claude 해석' : '키워드 폴백';
  $('#s-confirm-body').innerHTML = `
    ${dg}
    <div class="spec-line"><span class="k">종목</span><span class="v">${p.tickers.join(', ')}</span></div>
    <div class="spec-line"><span class="k">기간</span><span class="v">${p.from} ~ ${p.to}</span></div>
    <div class="spec-line"><span class="k">전략</span><span class="v">${descStrategy(p.strategy)}</span></div>
    <div class="spec-line"><span class="k">판정 기준</span><span class="v">${BENCH_KO[p.benchmark] || '자기 매수후보유'} 대비 위험대비수익(칼마)</span></div>
    <div class="spec-line"><span class="k">집행</span><span class="v">${descExec(p.exec)}</span></div>
    <div class="assump">
      <div class="assump-t">가정 (모두 명시)</div>
      <ul>
        <li>집행: <b>${descExec(p.exec)}</b></li>
        <li>체결: 신호 다음 봉(T+1) 종가 · 부분체결·지정가 없음</li>
        <li>비용: 반스프레드 2bps + 변동성비례 슬리피지(회전마다 편도)</li>
        <li>데이터: Yahoo 조정종가 — 운용보수 가격 반영(net-of-fee)</li>
        <li>판정: ${BENCH_KO[p.benchmark] || '자기 매수후보유'} 대비 칼마 (±10% 근소는 PUSH)</li>
      </ul>
    </div>
    <details class="jsonwrap"><summary>확정 JSON 스펙 (재현용) · <span class="tag">${engineTag}</span></summary>
      <pre id="spec-json">${JSON.stringify({ strategy: p.strategy, tickers: p.tickers, from: p.from, to: p.to }, null, 2)}</pre>
      <button class="btn ghost" id="copy-json">JSON 복사</button>
      <span class="jsonnote">자연어는 입구일 뿐, 저장된 이 JSON이 그대로 재실행됩니다(같은 문장도 LLM은 다르게 해석할 수 있어요).</span>
    </details>`;
  const cp = $('#copy-json');
  if (cp) cp.onclick = () => { navigator.clipboard?.writeText($('#spec-json').textContent); cp.textContent = '복사됨 ✓'; };
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let LAST_RESULT = null; // 내보내기용
async function runWith(tickers, strategy, from, to, benchmark, exec) {
  const body = $('#s-result-body');
  $('#s-result-panel').classList.remove('hidden');
  $('#s-result-panel').classList.add('reveal');
  body.innerHTML = '<div class="loading"><span class="spinner"></span>백테스트 실행 중…</div>';
  $('#s-status').innerHTML = '';
  $('#s-result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const r = await (await fetch('/api/simple', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers, strategy, from, to, benchmark: benchmark || 'self', exec: exec || null }),
    })).json();
    if (!r.ok) throw new Error(r.error || '실행 실패');
    LAST_RESULT = { result: r.result, input: { tickers, strategy, from, to, benchmark: benchmark || 'self', exec: exec || null } };
    renderSimpleResult(r.result);
  } catch (e) {
    body.innerHTML = `<div class="err">실행 오류: ${e.message}</div>`;
  }
}

// ── 포트폴리오 모드 ──
const ALLOC_KO = { equal: '동일가중', inverseVol: '역변동성' };
const REBAL_KO = { none: '없음', monthly: '매월', quarterly: '분기', yearly: '매년' };
function pfReadExec() {
  const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : 0; };
  return { stopLoss: num('#pf-stop'), takeProfit: num('#pf-tp'), trailingStop: num('#pf-trail'), sizing: $('#pf-sizing').value };
}
async function runPortfolio() {
  const tickers = $('#pf-tickers').value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  if (tickers.length < 2) { $('#pf-status').innerHTML = '<span class="err">종목을 2개 이상 입력하세요.</span>'; return; }
  const nl = $('#pf-nl').value.trim();
  if (!nl) { $('#pf-status').innerHTML = '<span class="err">전략을 자연어로 입력하세요.</span>'; return; }
  const v = $('#pf-period').value, today = new Date(), to = today.toISOString().slice(0, 10);
  const from = v === 'max' ? '2000-01-01' : new Date(Date.UTC(today.getUTCFullYear() - parseInt(v, 10), today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
  const body = $('#pf-result-body');
  $('#pf-result-panel').classList.remove('hidden');
  $('#pf-result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  body.innerHTML = '<div class="loading"><span class="spinner"></span>전략 해석 중…</div>';
  $('#pf-status').innerHTML = '';
  let spec;
  try { spec = (await parseNLraw(nl)).strategy; } catch (e) { body.innerHTML = `<div class="err">해석 오류: ${e.message}</div>`; return; }
  const payload = { tickers, strategy: spec, from, to, allocation: $('#pf-alloc').value, rebalance: $('#pf-rebal').value, benchmark: $('#pf-benchmark').value, exec: pfReadExec() };
  runPortfolioWith(payload);
}
async function runPortfolioWith(payload) {
  const body = $('#pf-result-body');
  $('#pf-result-panel').classList.remove('hidden');
  $('#pf-result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  body.innerHTML = '<div class="loading"><span class="spinner"></span>포트폴리오 시뮬레이션 중… (정렬·리밸런싱·통계)</div>';
  try {
    const r = await (await fetch('/api/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
    if (!r.ok) throw new Error(r.error || '실행 실패');
    LAST_RESULT = { result: r.result, input: payload, kind: 'portfolio' };
    renderPortfolio(r.result);
  } catch (e) { body.innerHTML = `<div class="err">실행 오류: ${e.message}</div>`; }
}
// NL → 스펙만(폼 채우지 않음)
async function parseNLraw(nl) {
  const r = await (await fetch('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: nl, mode: 'simple' }) })).json();
  if (!r.ok) throw new Error(r.error || '해석 실패');
  return r.spec;
}
function renderPortfolio(res) {
  const body = $('#pf-result-body');
  const p = res.portfolio, m = p.metrics, b = p.benchmark;
  const tagCls = p.verdict.state === 'quant' ? 'pass' : p.verdict.state === 'cut' ? 'fail' : 'pushtag';
  const dropNote = res.dropped && res.dropped.length ? `<div class="downgrade-banner">⚠ 제외된 종목: ${res.dropped.join(', ')} (데이터 부족/캘린더 불일치)</div>` : '';
  const benchRow = b.kind === 'cash' ? '' : metricRow(`기준: ${b.label}`, b, 'bh', null);
  const maxShare = Math.max(...p.contrib.map((c) => Math.abs(c.share)), 0.01);
  const contribRows = p.contrib.map((c) => {
    const w = (Math.abs(c.share) / maxShare) * 100;
    return `<tr><td>${c.ticker}</td><td class="num">${fmtPct(c.avgWeight)}</td><td class="num ${c.pnl >= 0 ? 'up' : 'down'}">${c.pnl >= 0 ? '+' : ''}${(c.pnl * 100).toFixed(1)}%p</td>
      <td class="barcell"><div class="bar ${c.pnl >= 0 ? 'pos' : 'neg'}" style="width:${w.toFixed(0)}%"></div></td>
      <td class="num">${(c.share * 100).toFixed(0)}%</td></tr>`;
  }).join('');
  const ci = p.calmarCI, k = p.checks;

  body.innerHTML = `
    ${dropNote}
    <div class="pf-verdict ${p.verdict.state}">
      <div class="pfv-tag ${tagCls}">${p.verdict.label}</div>
      <div class="pfv-meta">
        <div class="pfv-title">${res.used.join(' · ')}</div>
        <div class="pfv-sub">${p.label} · ${ALLOC_KO[p.allocation]} · 리밸 ${REBAL_KO[p.rebalance]} · ${res.from}~${res.to} · 기준 ${b.label}</div>
      </div>
    </div>
    ${metricsTable(metricRow('포트폴리오', m, 'strat', b.kind === 'cash' ? null : b) + benchRow)}
    ${equityChartSVG(p.chart, p.oos.splitIdx)}
    <div class="stat-grid">
      <div class="stat-box"><div class="sb-t">표본 외(OOS) — 뒤 40% · 분리 ${p.oos.split}</div>
        <div class="sb-row"><b class="${p.oos.test.calmar > (p.oos.benchTest.calmar ?? 0) ? 'win' : 'lose'}">${fmtR(p.oos.test.calmar)}</b> <span class="vs">vs 기준 ${fmtR(p.oos.benchTest.calmar ?? 0)}</span></div>
        <div class="sb-hint">안 본 뒷구간에서도 기준 대비 우위인가</div></div>
      <div class="stat-box"><div class="sb-t">칼마 90% 신뢰구간 (부트스트랩)</div>
        <div class="sb-row"><b>${ci ? fmtR(ci.lo) + ' ~ ' + fmtR(ci.hi) : '—'}</b></div>
        <div class="sb-hint">단일 경로의 운인지 — 재배열 시 범위</div></div>
      <div class="stat-box"><div class="sb-t">확증</div>
        <div class="sb-checks">${CHK(k.baseBeat)} 베이스 우위 · ${CHK(k.oosBeat)} OOS 유지 · ${CHK(k.ciPositive)} CI 양수</div>
        <div class="sb-hint">회전 ${m.turns}회 · 리밸 ${m.rebalances}회 · 총비용 −${(m.costPaid * 100).toFixed(2)}%p</div></div>
    </div>
    <div class="contrib-wrap">
      <div class="cw-t">종목 기여도 분해 (근사) — 총수익 ${(m.totalReturn * 100).toFixed(1)}%p 중</div>
      <table class="cmp-table"><thead><tr><th>Ticker</th><th>평균 비중</th><th>기여 P&L</th><th>기여도</th><th>몫</th></tr></thead><tbody>${contribRows}</tbody></table>
    </div>
    <div class="export-bar"><span class="eb-label">내보내기</span>
      <button class="btn ghost" id="pf-exp-json">JSON</button>
      <button class="btn ghost" id="pf-exp-share">공유 링크 복사</button>
      <span id="pf-exp-status"></span></div>
    <div class="provenance">데이터: Yahoo 조정종가 <b>(net-of-fee)</b> · 공통 거래일 교집합 정렬 · 거래비용 변동성비례 + 리밸런싱 비용 · 기여도는 슬리브 P&L 근사(리밸런싱 교차항 제외)
      <br>⚠ <b>생존 편향</b>: 살아남은 종목만 · <b>역변동성 가중</b>은 전기간 변동성 사용(경미한 룩어헤드).</div>`;
  $('#pf-exp-json').onclick = () => { if (LAST_RESULT) download(`portfolio_${res.from}_${res.to}.json`, JSON.stringify(LAST_RESULT, null, 2), 'application/json'); };
  $('#pf-exp-share').onclick = () => {
    const code = b64encode(JSON.stringify({ ...LAST_RESULT.input, _pf: 1 }));
    const url = `${location.origin}${location.pathname}#pf=${code}`;
    navigator.clipboard?.writeText(url).then(() => { $('#pf-exp-status').textContent = '링크 복사됨 ✓'; });
  };
}

// 서버 판정 상태 → 보드 색/태그.
const STATE_CLS = { quant: 'c-quant', weak: 'c-push', push: 'c-push', cut: 'c-cut', err: 'c-err' };
function boardVerdict(r) {
  if (r.error) return { tag: 'NO-DATA', cls: 'c-err' };
  return { tag: r.verdict.label, cls: STATE_CLS[r.verdict.state] || 'c-cut' };
}

function renderSimpleResult(res) {
  const body = $('#s-result-body');
  body.innerHTML = '';
  const rows = res.rows;
  const leftW = Math.max(6, ...rows.map((r) => r.ticker.length));
  const c = res.summary.counts;

  const benchLabel = res.benchmark?.label || '자기 매수후보유';
  const board = el('div', 'board wideboard');
  board.innerHTML = `
    <div class="board-caption"><span class="eyebrow">BACK TEST</span><span class="strat">${res.spec.label || res.spec.type} · ${res.from}~${res.to} · 기준 ${benchLabel}</span></div>
    <div class="board-cols"><div>Ticker</div><div>Verdict</div></div>
    <div class="board-rows"></div>`;
  const rowsEl = board.querySelector('.board-rows');
  rows.forEach((r) => { const v = boardVerdict(r); rowsEl.appendChild(boardRow(r.ticker, 'c-sym', v.tag, v.cls, '', leftW, 11)); });
  const totalTxt = `${c.quant} QUANT${c.weak ? ' / ' + c.weak + ' QUANT?' : ''}${c.push ? ' / ' + c.push + ' PUSH' : ''}`;
  const finalRow = c.quant ? 'blue' : ((c.weak || c.push) ? 'amberrow' : 'redrow');
  const finalCls = c.quant ? 'c-quant' : ((c.weak || c.push) ? 'c-push' : 'c-cut');
  rowsEl.appendChild(boardRow('TOTAL', 'c-final', totalTxt, finalCls, 'final ' + finalRow, leftW, Math.max(16, totalTxt.length)));
  body.appendChild(board);

  // 다중비교 경고 + 세션 카운터
  const M = rows.filter((r) => !r.error).length;
  let session = 0;
  try { session = (parseInt(localStorage.getItem('bt_tests') || '0', 10) || 0) + M; localStorage.setItem('bt_tests', String(session)); } catch (e) { session = M; }
  const mc = el('div', 'multi-comp');
  mc.innerHTML = `⚠ <b>다중비교 주의</b> — 이번 실행에서 ${M}개 종목을 동시 검정했고, 이 브라우저에서 누적 <b>${session}회</b> 테스트했습니다.
    후보를 많이 돌릴수록 <b>우연히 QUANT가 나올 확률</b>이 커집니다. 아래 각 종목의 <b>OOS·랜덤대조·신뢰구간</b>으로 우연 여부를 판별하세요.`;
  body.appendChild(mc);

  if (res.benchmark?.note) {
    const bn = el('div', 'downgrade-banner', `⚠ ${res.benchmark.note}`);
    body.appendChild(bn);
  }

  // 내보내기 도구모음
  const bar = el('div', 'export-bar');
  bar.innerHTML = `<span class="eb-label">내보내기</span>
    <button class="btn ghost" id="exp-csv">CSV</button>
    <button class="btn ghost" id="exp-json">JSON</button>
    <button class="btn ghost" id="exp-share">공유 링크 복사</button>
    <span id="exp-status"></span>`;
  body.appendChild(bar);
  $('#exp-csv').onclick = () => exportCSV(res);
  $('#exp-json').onclick = () => exportJSON();
  $('#exp-share').onclick = () => exportShare();

  // 이전 실행과 비교
  const priors = loadHistory();
  if (priors.length) {
    const cmp = el('div', 'compare');
    cmp.innerHTML = `<div class="cmp-head"><span class="ch-t">이전 실행과 비교 (A/B)</span>
      <select id="cmp-base"></select>
      <button class="btn ghost" id="cmp-clear">기록 초기화</button></div>
      <div id="cmp-table"></div>`;
    body.appendChild(cmp);
    const sel = cmp.querySelector('#cmp-base');
    sel.innerHTML = priors.slice().reverse().map((p) => `<option value="${p.ts}">${p.at} · ${p.label} (${p.from}~${p.to})</option>`).join('') + '<option value="none">비교 안 함</option>';
    sel.onchange = () => updateCompare(res.rows, priors, sel.value);
    cmp.querySelector('#cmp-clear').onclick = () => { localStorage.removeItem('bt_history'); cmp.remove(); };
    updateCompare(res.rows, priors, sel.value);
  }

  const cm = rows.find((r) => r.strat)?.strat?.costModel;
  const costDesc = cm ? `반스프레드 ${cm.halfSpreadBps}bps + 변동성비례 슬리피지(일변동성 × ${cm.slippageVolMult})` : '스프레드+슬리피지';
  const prov = el('div', 'provenance',
    `데이터: Yahoo 조정종가 <b>(배당·분할 반영 net-of-fee)</b> · 거래비용: <b>${costDesc}</b>, 회전마다 편도 부과 — 변동성 큰 레버리지 ETF일수록 자동으로 비싸짐 · 신호 T+1 · 판정: 매수후보유 대비 칼마` +
    `<br>⚠ <b>생존 편향</b>: 지금 보이는 건 <u>살아남은 종목</u>뿐입니다. 청산된 3배 ETF 다수는 표본에 없어 결과가 낙관적으로 치우칠 수 있습니다.`);
  body.appendChild(prov);

  // 런카드(재현 산출물)
  const rc = res.runCard;
  const runcard = el('details', 'runcard');
  runcard.innerHTML = `<summary>런카드 (재현용 산출물) · ${rc.version}</summary>
    <div class="rc-body">
      <div>버전: <code>${rc.version}</code></div>
      <div>실행 시각(UTC): <code>${rc.ranAt}</code></div>
      <div>데이터: ${rc.dataSource}</div>
      <div>거래비용: 수수료 ${rc.costModel.commissionBps}bps + 반스프레드 ${rc.costModel.halfSpreadBps}bps + 슬리피지(일변동성 × ${rc.costModel.slippageVolMult}) · 편도, 회전마다 · 운용보수 가격 반영</div>
      <div>통계: 부트스트랩 ${rc.iters.bootstrap}회(블록20) · 랜덤대조 ${rc.iters.control}회 · OOS train ${Math.round(rc.iters.oosTrainFrac * 100)}%</div>
      <div>집행: ${rc.execution}</div>
      <div class="rc-note">동일 입력 → 동일 결과(시드 고정). 위 스펙 JSON은 해석 확인 단계에서 복사·저장할 수 있습니다.</div>
    </div>`;
  body.appendChild(runcard);

  // 수치 상세(펼치기)
  const details = el('div', 'details-section');
  const btn = el('button', 'btn ghost', '종목별 통계 상세 펼치기 ▾');
  const dc = el('div', 'details hidden');
  rows.forEach((r) => dc.appendChild(simpleCard(r)));
  if (new URLSearchParams(location.search).get('demo')) { dc.classList.remove('hidden'); btn.textContent = '접기 ▴'; }
  btn.onclick = () => { dc.classList.toggle('hidden'); btn.textContent = dc.classList.contains('hidden') ? '종목별 통계 상세 펼치기 ▾' : '접기 ▴'; };
  details.appendChild(btn); details.appendChild(dc);
  body.appendChild(details);

  // 현재 실행을 히스토리에 저장(다음 실행이 이걸 기준으로 비교).
  try { const h = loadHistory(); h.push(buildHistoryEntry(res, LAST_RESULT?.input)); saveHistory(h); } catch (e) {}

  animateBoard(board);
}

const CHK = (ok) => ok ? '<span class="chk y">✓</span>' : '<span class="chk n">✗</span>';

// 자산곡선(로그) + 낙폭 차트 — 라이브러리 없이 인라인 SVG.
function equityChartSVG(chart, oosIdx) {
  const pts = chart?.pts, n = chart?.n;
  if (!pts || pts.length < 2) return '';
  const W = 720, padL = 48, padR = 14, eqTop = 14, eqBot = 150, ddTop = 178, ddBot = 248;
  const trades = chart.trades || [];
  let lmin = Infinity, lmax = -Infinity, maxDd = 0;
  for (const p of pts) {
    const s = Math.log(Math.max(p.s, 1e-6)), b = Math.log(Math.max(p.b, 1e-6));
    if (s < lmin) lmin = s; if (b < lmin) lmin = b; if (s > lmax) lmax = s; if (b > lmax) lmax = b;
    if (p.d > maxDd) maxDd = p.d;
  }
  for (const tr of trades) { const l = Math.log(Math.max(tr.eq, 1e-6)); if (l < lmin) lmin = l; if (l > lmax) lmax = l; }
  const span = (lmax - lmin) || 1;
  const xOf = (i) => padL + (i / (n - 1)) * (W - padL - padR);
  const yEq = (v) => eqBot - (Math.log(Math.max(v, 1e-6)) - lmin) / span * (eqBot - eqTop);
  const yDd = (d) => ddTop + (maxDd > 0 ? d / maxDd : 0) * (ddBot - ddTop);
  const line = (key) => pts.map((p) => `${xOf(p.i).toFixed(1)},${yEq(p[key]).toFixed(1)}`).join(' ');
  const ddPath = `M ${xOf(pts[0].i).toFixed(1)},${ddTop} ` + pts.map((p) => `L ${xOf(p.i).toFixed(1)},${yDd(p.d).toFixed(1)}`).join(' ') + ` L ${xOf(pts[pts.length - 1].i).toFixed(1)},${ddTop} Z`;
  const oosX = xOf(oosIdx).toFixed(1);
  const mult = (lg) => '×' + Math.exp(lg).toFixed(Math.exp(lg) >= 10 ? 0 : 1);
  // 매수(진입) ▲ / 매도(청산) ▼ 마커.
  let buys = 0, sells = 0;
  const marks = trades.map((tr) => {
    const x = xOf(tr.i), y = yEq(tr.eq);
    if (tr.type === 'buy') { buys++; return `<path class="mk buy" d="M${(x - 3.4).toFixed(1)},${(y + 6).toFixed(1)} L${(x + 3.4).toFixed(1)},${(y + 6).toFixed(1)} L${x.toFixed(1)},${(y + 0.5).toFixed(1)} Z"><title>매수 ${tr.iso}</title></path>`; }
    sells++; return `<path class="mk sell" d="M${(x - 3.4).toFixed(1)},${(y - 6).toFixed(1)} L${(x + 3.4).toFixed(1)},${(y - 6).toFixed(1)} L${x.toFixed(1)},${(y - 0.5).toFixed(1)} Z"><title>매도 ${tr.iso}</title></path>`;
  }).join('');
  return `<svg class="eqchart" viewBox="0 0 ${W} 260" preserveAspectRatio="xMidYMid meet">
    <line class="grid" x1="${padL}" y1="${eqBot}" x2="${W - padR}" y2="${eqBot}"/>
    <text class="lab" x="4" y="${eqTop + 8}">${mult(lmax)}</text>
    <text class="lab" x="4" y="${eqBot}">${mult(lmin)}</text>
    <text class="lab" x="4" y="${ddTop + 9}">DD</text>
    <text class="lab" x="4" y="${ddBot}">-${(maxDd * 100).toFixed(0)}%</text>
    <path class="ddarea" d="${ddPath}"/>
    <polyline class="bh" points="${line('b')}"/>
    <polyline class="strat" points="${line('s')}"/>
    ${marks}
    <line class="oos" x1="${oosX}" y1="${eqTop}" x2="${oosX}" y2="${ddBot}"/>
    <text class="oos-lab" x="${oosX}" y="${eqTop - 3}">OOS→</text>
    <text class="leg strat-l" x="${W - padR}" y="${eqTop + 8}">— 전략</text>
    <text class="leg bh-l" x="${W - padR - 66}" y="${eqTop + 8}">— 매수후보유</text>
    <text class="leg buy-l" x="${padL + 2}" y="${eqTop + 8}">▲ 매수 ${buys}</text>
    <text class="leg sell-l" x="${padL + 74}" y="${eqTop + 8}">▼ 매도 ${sells}</text>
  </svg>`;
}

function simpleCard(r) {
  const card = el('div', 'ticker-card');
  if (r.error) {
    card.innerHTML = `<div class="tc-head"><span class="sym">${r.ticker}</span><span class="idx-name">${r.name || ''}</span><span class="verdict-tag fail">${r.error}</span></div>`;
    return card;
  }
  const tagCls = r.verdict.state === 'quant' ? 'pass' : (r.verdict.state === 'cut' ? 'fail' : 'pushtag');
  const ci = r.calmarCI, ctrl = r.control, k = r.checks;
  const ciTxt = ci ? `${ci.lo.toFixed(2)} ~ ${ci.hi.toFixed(2)} (중앙 ${ci.med.toFixed(2)})` : '—';
  const pctTxt = ctrl ? `상위 ${((1 - ctrl.percentile) * 100).toFixed(0)}% (랜덤 ${(ctrl.percentile * 100).toFixed(0)}% 초과)` : '—';
  card.innerHTML = `
    <div class="tc-head">
      <span class="sym">${r.ticker}</span><span class="idx-name">${r.name || ''}</span>
      <span class="verdict-tag ${tagCls}">${r.verdict.label}</span>
    </div>
    <div class="tc-body open">
      ${metricsTable(metricRow('전략(전체)', r.strat, 'strat', r.bh) + metricRow('매수후보유', r.bh, 'bh', null) + (r.bench ? metricRow('기준: ' + r.bench.label, r.bench, 'bh', null) : ''))}
      ${equityChartSVG(r.chart, r.oos.splitIdx)}
      <div class="stat-grid">
        <div class="stat-box">
          <div class="sb-t">표본 외(OOS) — 뒤 40% 검증 · 분리 ${r.oos.split}</div>
          <div class="sb-row"><span>전략 칼마</span><b class="${r.oos.test.strat.calmar > r.oos.test.bh.calmar ? 'win' : 'lose'}">${fmtR(r.oos.test.strat.calmar)}</b> <span class="vs">vs B&H ${fmtR(r.oos.test.bh.calmar)}</span></div>
          <div class="sb-hint">과거(train)가 아니라 <b>보지 않은 뒷구간</b>에서도 우위인가</div>
        </div>
        <div class="stat-box">
          <div class="sb-t">칼마 90% 신뢰구간 (블록 부트스트랩)</div>
          <div class="sb-row"><b>${ciTxt}</b></div>
          <div class="sb-hint">"칼마 ${fmtR(r.strat.calmar)}"가 단일 경로의 운인지 — 재배열 시 이 범위</div>
        </div>
        <div class="stat-box">
          <div class="sb-t">랜덤 대조 (타이밍 셔플 ${''}200회)</div>
          <div class="sb-row"><b>${pctTxt}</b></div>
          <div class="sb-hint">같은 보유량·회전을 무작위로 배치했을 때 대비 — 타이밍이 우연 이상인가</div>
        </div>
        <div class="stat-box">
          <div class="sb-t">확증 (${k.corrob}/3)</div>
          <div class="sb-checks">${CHK(k.baseBeat)} 베이스 우위 · ${CHK(k.oosBeat)} OOS 유지 · ${CHK(k.vsRandom)} 랜덤 초과 · ${CHK(k.ciPositive)} CI 양수</div>
          <div class="sb-hint">${r.verdict.state === 'weak' ? '베이스만 이기고 확증이 부족 → 확언 못 함(QUANT?)' : r.verdict.state === 'quant' ? '다차원 확증 충족' : r.verdict.state === 'push' ? '매수후보유와 근소차' : '베이스 미달'}</div>
        </div>
      </div>
      <div class="cost-line">실현 거래비용: 회전 <b>${r.strat.turns}회</b> · 평균 <b>${r.strat.avgTurnBps.toFixed(1)}bps</b>/편도 · 총 <b>−${(r.strat.costPaid * 100).toFixed(2)}%p</b> 차감</div>
      <div style="color:var(--faint);font-size:10.5px;margin-top:6px">${r.strat.from} → ${r.strat.to} · ${r.strat.bars}봉 · 노출 ${fmtPct(r.strat.exposure)}</div>
    </div>`;
  return card;
}

function setStep(active) {
  $$('.step').forEach((s) => {
    const n = +s.dataset.step;
    s.classList.toggle('active', n === active);
    s.classList.toggle('done', n < active);
  });
}

// ── 1. 해석 ──
$('#btn-parse').onclick = async () => {
  const request = $('#request').value.trim();
  if (!request) { $('#parse-status').innerHTML = '<span class="err">요청 문장을 입력하세요.</span>'; return; }
  $('#parse-status').innerHTML = '<span class="loading"><span class="spinner"></span>해석 중…</span>';
  try {
    const r = await (await fetch('/api/parse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request, mode: 'pro' }),
    })).json();
    if (!r.ok) throw new Error(r.error || '파싱 실패');
    SPEC = r.spec;
    $('#parse-status').innerHTML = `<span style="color:var(--muted);font-size:12px">해석됨 · ${r.spec.engine === 'llm' ? 'Claude' : '폴백'} — ${r.spec.notes || ''}</span>`;
    renderPrereg(SPEC);
    // 침묵 강등 경고
    const oldB = $('#pro-downgrade'); if (oldB) oldB.remove();
    if (r.spec.downgraded) {
      const b = el('div', 'downgrade-banner', `⚠ ${r.spec.downgradeNote || '요청을 해석하지 못해 기본 전략(200일 이동평균)으로 대체했습니다.'}`);
      b.id = 'pro-downgrade';
      $('#p-prereg').insertBefore(b, $('#p-prereg').firstChild.nextSibling);
    }
    $('#p-prereg').classList.remove('hidden');
    $('#p-prereg').classList.add('reveal');
    setStep(1);
    $('#p-prereg').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('#parse-status').innerHTML = `<span class="err">${e.message}</span>`;
  }
};

// ── 2. 사전등록 폼 ──
function field(label, inner, sub) {
  return `<div class="field"><label>${label}</label>${inner}${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}
function selectOpts(obj, val) {
  return Object.entries(obj).map(([k, v]) =>
    `<option value="${k}" ${k === val ? 'selected' : ''}>${v.label || k}</option>`).join('');
}

function renderPrereg(spec) {
  const s = spec.strategy || {};
  const type = s.type || 'ma_timing';
  const stMeta = META.strategyTypes[type];
  const grid = (s.grid && s.grid.length) ? s.grid : stMeta.defaultGrid;
  const chosen = s.chosenParam ?? grid[Math.floor(grid.length / 2)];
  const isDefaultGrid = JSON.stringify(grid) === JSON.stringify(stMeta.defaultGrid);
  const gridSub = isDefaultGrid
    ? `⚠ 기본 그리드 사용 중 (${chosen} 중심 — 평원 검사가 중앙값에 유리하게 편향될 수 있음). 직접 지정 권장.`
    : '평원 검사가 훑는 값들';

  const g = $('#prereg-grid');
  g.innerHTML =
    field('전략 타입', `<select id="f-type">${selectOpts(META.strategyTypes, type)}</select>`,
          stMeta.gridParam + ' 축을 그리드로 훑음') +
    field('MA 타입', `<select id="f-matype"><option value="sma" ${s.maType !== 'ema' ? 'selected' : ''}>SMA (단순)</option><option value="ema" ${s.maType === 'ema' ? 'selected' : ''}>EMA (지수)</option></select>`,
          '동급이면 단순한 SMA 우선') +
    field(`선택 파라미터 (${stMeta.gridParam})`, `<input id="f-chosen" type="number" step="any" value="${chosen}">`,
          '평원 중간값 — 피크 사냥 금지') +
    field('그리드 (쉼표 구분)', `<input id="f-grid" type="text" value="${grid.join(', ')}">`,
          gridSub) +
    field('무훼손 판정 규칙', `<select id="f-passrule">${selectOpts(META.passRules, spec.passRule || 'mdd_and_calmar')}</select>`,
          '관문 통과선') +
    field('평원 허용오차', `<input id="f-tol" type="number" step="0.01" value="${spec.plateau?.tolerance ?? 0.15}">`,
          '이웃 칼마가 피크의 (1−오차) 이상이면 평원') +
    field('과반 임계 (n/5)', `<input id="f-th" type="number" min="1" max="5" value="${spec.multiTicker?.threshold ?? 3}">`,
          '이만큼 통과해야 채택 (기본 3)');

  const allT = META.tickers;
  const chosenT = spec.tickers && spec.tickers.length ? spec.tickers : allT;
  const tg = $('#ticker-toggles');
  tg.innerHTML = '';
  allT.forEach((t) => {
    const on = chosenT.includes(t);
    const b = el('span', 'tk' + (on ? ' on' : ''), `${t} <span style="color:var(--faint)">${META.universe[t].name}</span>`);
    b.dataset.t = t;
    b.onclick = () => { if (isLocked()) return; b.classList.toggle('on'); markDirty(); };
    tg.appendChild(b);
  });

  $$('#prereg-form select, #prereg-form input').forEach((i) => i.addEventListener('input', markDirty));
}

function collectPrereg() {
  const type = $('#f-type').value;
  const grid = $('#f-grid').value.split(',').map((x) => parseFloat(x.trim())).filter((x) => isFinite(x));
  const tickers = $$('#ticker-toggles .tk.on').map((b) => b.dataset.t);
  return {
    strategy: {
      type,
      maType: $('#f-matype').value,
      chosenParam: parseFloat($('#f-chosen').value),
      grid,
    },
    passRule: $('#f-passrule').value,
    plateau: { neighborhood: 1, tolerance: parseFloat($('#f-tol').value) },
    multiTicker: { threshold: parseInt($('#f-th').value, 10) },
    tickers,
  };
}

const isLocked = () => $('#prereg-form').classList.contains('locked');

function markDirty() {
  if (!SEALED || !hasResult) return;
  // 봉인 후 결과를 본 상태에서 값이 바뀌면 과적합 경고.
  const now = JSON.stringify(collectPrereg());
  $('#overfit-notice').classList.toggle('show', now !== JSON.stringify(SEALED));
}

// 잠금
$('#btn-lock').onclick = () => {
  SEALED = collectPrereg();
  if (!SEALED.tickers.length) { alert('종목을 하나 이상 선택하세요.'); return; }
  $('#prereg-form').classList.add('locked');
  $$('#prereg-form select, #prereg-form input').forEach((i) => i.disabled = true);
  $('#reg-seal').style.display = 'inline-block';
  $('#btn-lock').classList.add('hidden');
  $('#btn-run').classList.remove('hidden');
  $('#btn-unlock').classList.remove('hidden');
  $('#overfit-notice').classList.remove('show');
  setStep(2);
};

// 해제(재등록)
$('#btn-unlock').onclick = () => {
  $('#prereg-form').classList.remove('locked');
  $$('#prereg-form select, #prereg-form input').forEach((i) => i.disabled = false);
  $('#reg-seal').style.display = 'none';
  $('#btn-lock').classList.remove('hidden');
  $('#btn-run').classList.add('hidden');
  $('#btn-unlock').classList.add('hidden');
  setStep(1);
};

// ── 3. 돌리기 ──
$('#btn-run').onclick = async () => {
  const body = $('#result-body');
  $('#p-result').classList.remove('hidden');
  $('#p-result').classList.add('reveal');
  body.innerHTML = '<div class="loading"><span class="spinner"></span>5종목 × 4리짐 × 그리드 백테스트 실행 중… (합성 데이터 재구성 포함)</div>';
  $('#p-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setStep(4);
  try {
    const r = await (await fetch('/api/backtest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preReg: SEALED }),
    })).json();
    if (!r.ok) throw new Error(r.error || '실행 실패');
    hasResult = true;
    renderResult(r.result);
  } catch (e) {
    body.innerHTML = `<div class="err">실행 오류: ${e.message}</div>`;
  }
};

// ── 결과 렌더: 항공편 출발 안내판(스플릿플랩) ──
const FLAP_CHARSET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:-/.';

// 한 글자 셀을 목표 글자까지 촤라락 넘긴 뒤 착지.
function flapCell(cell, target, delay, extraFlips) {
  const glyph = cell.querySelector('.glyph');
  target = (target || ' ').toUpperCase();
  if (!FLAP_CHARSET.includes(target)) target = ' ';
  if (target === ' ') { glyph.textContent = ' '; return; } // 공백은 넘김 없이 비움
  const flips = 8 + extraFlips;
  let step = 0, cur = 0;
  setTimeout(() => {
    const iv = setInterval(() => {
      cur = (cur + 1) % FLAP_CHARSET.length;
      glyph.textContent = FLAP_CHARSET[cur];
      cell.animate(
        [{ transform: 'rotateX(-88deg)', filter: 'brightness(1.6)' }, { transform: 'rotateX(0deg)', filter: 'brightness(1)' }],
        { duration: 90, easing: 'cubic-bezier(.3,.7,.3,1)' });
      if (++step >= flips) {
        clearInterval(iv);
        glyph.textContent = target;
        cell.classList.add('lit');
        cell.animate([{ transform: 'rotateX(-88deg)' }, { transform: 'rotateX(0deg)' }], { duration: 110, easing: 'ease-out' });
      }
    }, 42);
  }, delay);
}

// 세그먼트(글자열) → 셀 DOM 배열. cls로 색 상태 지정.
function buildSeg(text, cls, width) {
  const seg = el('div', 'seg ' + (cls || ''));
  const s = (text || '').toUpperCase();
  const w = width || s.length;
  for (let i = 0; i < w; i++) {
    const ch = s[i] || ' ';
    const cell = el('div', 'cell');
    cell.innerHTML = '<span class="dots-off"></span><span class="glyph"> </span>';
    cell.dataset.target = ch;
    seg.appendChild(cell);
  }
  return seg;
}

function boardRow(leftText, leftCls, rightText, rightCls, extraCls, leftW, rightW) {
  const row = el('div', 'brow ' + (extraCls || ''));
  row.appendChild(buildSeg(leftText, leftCls, leftW || 6));
  row.appendChild(buildSeg(rightText, rightCls, rightW || 11));
  return row;
}

function renderResult(res) {
  const body = $('#result-body');
  body.innerHTML = '';
  const adopt = res.verdict.decision === '채택';

  // 안내판
  const board = el('div', 'board');
  const s = SEALED.strategy;
  const stratLabel = `${(s.maType || 'sma').toUpperCase()}${s.chosenParam ?? ''} · 이중관문·평원 · ${res.multiTicker.threshold}/${res.universe.length}`;
  board.innerHTML = `
    <div class="board-caption"><span class="eyebrow">BACK TEST</span><span class="strat">${stratLabel}</span></div>
    <div class="board-cols"><div>Ticker</div><div>Verdict</div></div>
    <div class="board-rows"></div>`;
  const rows = board.querySelector('.board-rows');

  res.perTicker.forEach((pt) => {
    if (pt.error) { rows.appendChild(boardRow(pt.ticker, 'c-sym', 'ERROR', 'c-err')); return; }
    const pass = pt.tickerPass;
    rows.appendChild(boardRow(pt.ticker, 'c-sym', pass ? 'QUANT' : 'NOT-QUANT', pass ? 'c-quant' : 'c-cut'));
  });

  // 최종 판정 하이라이트 행 (이미지의 파란 행)
  const finalRow = boardRow('FINAL', 'c-final', adopt ? 'QUANT' : 'NOT-QUANT', adopt ? 'c-quant' : 'c-cut', 'final ' + (adopt ? 'blue' : 'redrow'));
  rows.appendChild(finalRow);
  body.appendChild(board);

  // 판정 요약(비-도트, 안내판 아래)
  const tally = el('div', 'tally-line');
  tally.innerHTML = `기준 통과 <b>${res.multiTicker.count} / ${res.universe.length}</b> (요구 ${res.multiTicker.threshold}) ·
    최종 <b class="${adopt ? 'q' : 'nq'}">${adopt ? 'QUANT (채택)' : 'NOT-QUANT (기각)'}</b>
    <span class="pnote">${res.verdict.principleNote}</span>`;
  body.appendChild(tally);

  // 상세 게이트 리포트(펼치기)
  const details = el('div', 'details-section');
  const btn = el('button', 'btn ghost', '상세 게이트 리포트 펼치기 ▾');
  const dc = el('div', 'details hidden');
  res.perTicker.forEach((pt) => dc.appendChild(tickerCard(pt)));
  const reasons = el('div', 'reasons');
  reasons.innerHTML = `<ul>${[...res.verdict.reasons, ...(res.verdict.failReasons || [])].map((x) => `<li>${x}</li>`).join('')}
    ${res.verdict.retrial?.length ? `<li class="retrial">재심: ${res.verdict.retrial.join(' ')}</li>` : ''}</ul>`;
  dc.insertBefore(reasons, dc.firstChild);
  btn.onclick = () => { dc.classList.toggle('hidden'); btn.textContent = dc.classList.contains('hidden') ? '상세 게이트 리포트 펼치기 ▾' : '접기 ▴'; };
  details.appendChild(btn); details.appendChild(dc);
  body.appendChild(details);

  // 촤라락 애니메이션 — 좌→우, 위→행 웨이브
  animateBoard(board);
}

function animateBoard(board) {
  const rowsEls = [...board.querySelectorAll('.brow')];
  rowsEls.forEach((row, ri) => {
    const cells = [...row.querySelectorAll('.cell')];
    cells.forEach((cell, ci) => {
      const delay = ri * 90 + ci * 55 + Math.floor(Math.random() * 40);
      const extra = ci + (row.classList.contains('final') ? 10 : 0);
      flapCell(cell, cell.dataset.target, delay, extra);
    });
  });
}

function metricRow(name, m, cls, bh) {
  const win = (a, b, higher = true) => a == null || b == null ? '' : ((higher ? a >= b : a <= b) ? 'win' : 'lose');
  return `<tr class="${cls}">
    <td>${name}</td>
    <td class="num ${bh ? win(m.cagr, bh.cagr) : ''}">${fmtPct(m.cagr)}</td>
    <td class="num ${bh ? win(m.mdd, bh.mdd, false) : ''}">${fmtPct(m.mdd)}</td>
    <td class="num ${bh ? win(m.calmar, bh.calmar) : ''}">${fmtR(m.calmar)}</td>
    <td class="num">${fmtR(m.sharpe)}</td>
    <td class="num" style="color:var(--faint)">${fmtPct(m.exposure)}</td>
  </tr>`;
}

function metricsTable(rows) {
  return `<table class="metrics">
    <thead><tr><th></th><th>CAGR</th><th>MDD</th><th>칼마</th><th>샤프</th><th>노출</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function segBlock(title, seg) {
  if (!seg || !seg.metrics) return '';
  const res = seg.pass ? '<span class="res pass">무훼손</span>' : '<span class="res fail">훼손</span>';
  return `<div class="gate-block">
    <h4>${title} ${res}</h4>
    ${metricsTable(
      metricRow('전략', seg.metrics, 'strat', seg.bh) +
      metricRow('매수후보유', seg.bh, 'bh', null))}
    <div style="color:var(--faint);font-size:10.5px;margin-top:6px">${seg.metrics.from} → ${seg.metrics.to} · ${seg.metrics.bars}봉</div>
  </div>`;
}

function surfaceSVG(surface, chosen) {
  if (!surface || !surface.length) return '';
  const W = 100, H = 100, pad = 4;
  const vals = surface.map((r) => isFinite(r.calmar) ? r.calmar : 0);
  const max = Math.max(...vals, 0.01);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const bw = (W - pad * 2) / surface.length;
  const zeroY = H - pad - ((0 - min) / range) * (H - pad * 2);
  let bars = '', labels = '';
  surface.forEach((r, i) => {
    const val = isFinite(r.calmar) ? r.calmar : 0;
    const y = H - pad - ((val - min) / range) * (H - pad * 2);
    const x = pad + i * bw;
    const top = Math.min(y, zeroY), h = Math.abs(zeroY - y);
    const cls = r.param === chosen ? 'bar chosen' : (r.pass ? 'bar pass' : 'bar');
    bars += `<rect class="${cls}" x="${x + bw * 0.12}" y="${top}" width="${bw * 0.76}" height="${Math.max(h, 0.6)}"><title>${r.param}: 칼마 ${fmtR(r.calmar)}</title></rect>`;
    if (i % 2 === 0 || r.param === chosen) labels += `<text x="${x + bw / 2}" y="${H - 0.5}" text-anchor="middle">${r.param}</text>`;
  });
  bars += `<line x1="${pad}" y1="${zeroY}" x2="${W - pad}" y2="${zeroY}" stroke="var(--line2)" stroke-width="0.4"/>`;
  return `<svg class="surface" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}${labels}</svg>`;
}

function tickerCard(pt) {
  const card = el('div', 'ticker-card');
  if (pt.error) {
    card.innerHTML = `<div class="tc-head"><span class="sym">${pt.ticker}</span>
      <span class="verdict-tag fail">오류</span></div>
      <div class="tc-body open"><div class="err">${pt.error}</div></div>`;
    return card;
  }
  const g1 = pt.gate1.pass, g2 = pt.gate2.pass, pl = pt.plateau.pass, pass = pt.tickerPass;
  const uni = META.universe[pt.ticker];
  const plRes = pl ? '<span class="res pass">평원</span>' : '<span class="res fail">고립 피크</span>';

  card.innerHTML = `
    <div class="tc-head">
      <span class="sym">${pt.ticker}</span>
      <span class="idx-name">${uni.name} · 기초 ${uni.index}</span>
      <div class="gate-dots" title="관문① / 관문② / 평원">
        <span class="gd ${g1 ? 'p' : 'f'}" title="관문①"></span>
        <span class="gd ${g2 ? 'p' : 'f'}" title="관문②"></span>
        <span class="gd ${pl ? 'p' : 'f'}" title="평원"></span>
      </div>
      <span class="verdict-tag ${pass ? 'pass' : 'fail'}">${pass ? '통과' : '기각'}</span>
    </div>
    <div class="tc-body">
      <div class="gate-block">
        <h4>관문① · QE 실데이터 (전·후반 모두 무훼손) ${pt.gate1.pass ? '<span class="res pass">통과</span>' : '<span class="res fail">실패</span>'}</h4>
      </div>
      ${segBlock('QE 전반', pt.gate1.qe_first)}
      ${segBlock('QE 후반', pt.gate1.qe_second)}
      <div style="height:8px"></div>
      <div class="gate-block">
        <h4>관문② · 잃어버린 10년 (닷컴 3배 합성) ${pt.gate2.pass ? '<span class="res pass">통과</span>' : '<span class="res fail">실패</span>'}</h4>
      </div>
      ${segBlock('2000~2010 합성', pt.gate2.lost)}
      <div style="height:8px"></div>
      <div class="plateau-wrap">
        <div class="cap"><h4 style="margin:0">평원 검사 · 그리드 칼마 표면 (QE 전체) ${plRes}</h4>
          <span style="color:var(--faint);font-size:10.5px">선택 ${pt.chosenParam} · ${pt.plateau.reason}</span></div>
        ${surfaceSVG(pt.surface, pt.chosenParam)}
      </div>
    </div>`;

  card.querySelector('.tc-head').onclick = () => card.querySelector('.tc-body').classList.toggle('open');
  if (pass) card.querySelector('.tc-body').classList.add('open');
  return card;
}

// 스모크 테스트용 자동 시연: /?demo=1(정밀), /?demo=simple(간편).
async function demoSimple() {
  $('.mode-switch .ms[data-mode="simple"]').click();
  $('#s-tickers').value = 'AAPL, NVDA, BTC-USD, SPY, 005930.KS';
  $('#s-nl').value = '200일 이동평균 위일 때만 보유';
  await runSimple();                 // 해석 확인 표시
  await new Promise((r) => setTimeout(r, 400));
  $('#s-confirm-run').click();       // 승인 → 실행
}
async function demo() {
  $('.mode-switch .ms[data-mode="pro"]').click();
  $('#request').value = 'TQQQ·SOXL·UPRO·TNA·LABU에 200일 이동평균 타이밍, 5종목 중 3개 통과해야 채택';
  await $('#btn-parse').onclick();
  await new Promise((r) => setTimeout(r, 300));
  $('#f-grid').value = '160, 180, 200, 220, 240';
  $('#f-chosen').value = '200';
  $('#btn-lock').onclick();
  await $('#btn-run').onclick();
}

async function demoConfirm() {
  $('.mode-switch .ms[data-mode="simple"]').click();
  $('#s-tickers').value = 'AAPL, NVDA, SPY';
  $('#s-nl').value = '종가가 200일선 위이고 RSI가 70 아래일 때만 보유';
  await runSimple(); // 해석 확인에서 멈춤
}
async function demoCompare() {
  $('.mode-switch .ms[data-mode="simple"]').click();
  try { localStorage.removeItem('bt_history'); } catch (e) {}
  const tk = ['NVDA', 'AAPL', 'SPY'], from = '2019-01-01', to = '2025-01-01';
  await runWith(tk, { type: 'ma_timing', maType: 'sma', chosenParam: 200, label: 'MA·200' }, from, to, 'self');
  await runWith(tk, { type: 'ma_timing', maType: 'sma', chosenParam: 100, label: 'MA·100' }, from, to, 'self');
}
async function demoPortfolio() {
  $('.mode-switch .ms[data-mode="portfolio"]').click();
  $('#pf-tickers').value = 'SPY, TLT, GLD';
  $('#pf-nl').value = '200일 이동평균 위일 때만 보유';
  $('#pf-rebal').value = 'quarterly';
  await runPortfolioWith({ tickers: ['SPY', 'TLT', 'GLD'], strategy: { type: 'ma_timing', maType: 'sma', chosenParam: 200, label: 'MA·200' }, from: '2010-01-01', to: '2025-12-31', allocation: 'equal', rebalance: 'quarterly', benchmark: 'self', exec: {} });
}
boot().then(() => {
  if (tryShareLink()) return;
  const d = new URLSearchParams(location.search).get('demo');
  if (d === 'portfolio') return demoPortfolio();
  if (d === 'simple') demoSimple();
  else if (d === 'confirm') demoConfirm();
  else if (d === 'compare') demoCompare();
  else if (d) demo();
});
