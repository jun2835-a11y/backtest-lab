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
      $('#mode-pro').classList.toggle('hidden', mode !== 'pro');
    };
  });

  // 전략은 자연어 입력만 사용 — 해석 → 확인 → 실행
  $('#s-run').onclick = runSimple;
  $('#s-confirm-run').onclick = () => {
    if (!PENDING) return;
    $('#s-confirm-panel').classList.add('hidden');
    saveSpec(PENDING);
    runWith(PENDING.tickers, PENDING.strategy, PENDING.from, PENDING.to);
  };
  $('#s-confirm-cancel').onclick = () => $('#s-confirm-panel').classList.add('hidden');

  // 지난 스펙 재실행(재현성): LLM 재해석 없이 저장된 JSON 그대로.
  const saved = loadSpec();
  if (saved) {
    const b = $('#s-rerun');
    b.classList.remove('hidden');
    b.onclick = () => { PENDING = saved; runWith(saved.tickers, saved.strategy, saved.from, saved.to); };
  }
}

// ── 스펙 저장/로드(재현성) ──
function saveSpec(p) { try { localStorage.setItem('bt_last_spec', JSON.stringify(p)); } catch (e) {} }
function loadSpec() { try { return JSON.parse(localStorage.getItem('bt_last_spec')); } catch (e) { return null; } }

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
  PENDING = { strategy: spec.strategy, tickers, from, to, notes: spec.notes, engine: spec.engine, downgraded: spec.downgraded, downgradeNote: spec.downgradeNote };
  renderConfirm(PENDING);
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
    <div class="assump">
      <div class="assump-t">고정 가정 (모두 명시)</div>
      <ul>
        <li>포지션: 100% 보유 또는 현금 (부분·분할 없음)</li>
        <li>익절·손절: 없음</li>
        <li>집행: 신호 다음 봉(T+1)</li>
        <li>비용: 거래 왕복 5bps</li>
        <li>데이터: Yahoo 조정종가 — 운용보수는 가격에 이미 반영(net-of-fee)</li>
        <li>판정: 매수후보유 대비 칼마 (±10% 근소는 PUSH)</li>
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

async function runWith(tickers, strategy, from, to) {
  const body = $('#s-result-body');
  $('#s-result-panel').classList.remove('hidden');
  $('#s-result-panel').classList.add('reveal');
  body.innerHTML = '<div class="loading"><span class="spinner"></span>백테스트 실행 중…</div>';
  $('#s-status').innerHTML = '';
  $('#s-result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const r = await (await fetch('/api/simple', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers, strategy, from, to }),
    })).json();
    if (!r.ok) throw new Error(r.error || '실행 실패');
    renderSimpleResult(r.result);
  } catch (e) {
    body.innerHTML = `<div class="err">실행 오류: ${e.message}</div>`;
  }
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

  const board = el('div', 'board wideboard');
  board.innerHTML = `
    <div class="board-caption"><span class="eyebrow">BACK TEST</span><span class="strat">${res.spec.label || res.spec.type} · ${res.from}~${res.to}</span></div>
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

  const turn = rows.find((r) => r.strat)?.strat?.costModel?.turnCost ?? 0.0005;
  const prov = el('div', 'provenance',
    `데이터: Yahoo 조정종가 <b>(배당·분할 반영 net-of-fee)</b> · 비용: 거래 왕복 ${(turn * 10000).toFixed(0)}bps(고정 — 레버리지 ETF 실제 스프레드/슬리피지는 더 클 수 있음) · 신호 T+1 · 판정: 매수후보유 대비 칼마` +
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
      <div>비용 모델: 거래 ${(rc.costModel.turnCost * 10000).toFixed(0)}bps · 운용보수 ${rc.costModel.expenseRatio === 0 ? '가격 반영(0 추가)' : rc.costModel.expenseRatio}</div>
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
  btn.onclick = () => { dc.classList.toggle('hidden'); btn.textContent = dc.classList.contains('hidden') ? '종목별 통계 상세 펼치기 ▾' : '접기 ▴'; };
  details.appendChild(btn); details.appendChild(dc);
  body.appendChild(details);

  animateBoard(board);
}

const CHK = (ok) => ok ? '<span class="chk y">✓</span>' : '<span class="chk n">✗</span>';

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
      ${metricsTable(metricRow('전략(전체)', r.strat, 'strat', r.bh) + metricRow('매수후보유', r.bh, 'bh', null))}
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
      <div style="color:var(--faint);font-size:10.5px;margin-top:8px">${r.strat.from} → ${r.strat.to} · ${r.strat.bars}봉 · 노출 ${fmtPct(r.strat.exposure)}</div>
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
boot().then(() => {
  const d = new URLSearchParams(location.search).get('demo');
  if (d === 'simple') demoSimple();
  else if (d === 'confirm') demoConfirm();
  else if (d) demo();
});
