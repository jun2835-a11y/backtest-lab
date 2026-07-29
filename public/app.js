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

  // 전략은 자연어 입력만 사용 (드롭다운 제거) — 실행 시 해석→백테스트
  $('#s-run').onclick = runSimple;
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

async function runSimple() {
  const nl = $('#s-nl').value.trim();
  if (!nl) { $('#s-status').innerHTML = '<span class="err">전략을 자연어로 입력하세요.</span>'; return; }
  const { from, to } = periodRange();
  const body = $('#s-result-body');
  $('#s-result-panel').classList.remove('hidden');
  $('#s-result-panel').classList.add('reveal');
  body.innerHTML = '<div class="loading"><span class="spinner"></span>전략 해석 중…</div>';
  $('#s-status').innerHTML = '';
  $('#s-result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  let strategy;
  try {
    const spec = await parseNL(nl);   // 자연어 → 전략 스펙
    strategy = spec.strategy;
  } catch (e) {
    body.innerHTML = `<div class="err">해석 오류: ${e.message}</div>`;
    return;
  }
  const tickers = $('#s-tickers').value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  if (!tickers.length) { body.innerHTML = '<div class="err">종목을 입력하세요. (또는 전략 문장에 종목을 포함)</div>'; return; }
  await runWith(tickers, strategy, from, to);
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

function renderSimpleResult(res) {
  const body = $('#s-result-body');
  body.innerHTML = '';
  const rows = res.rows;
  const leftW = Math.max(6, ...rows.map((r) => r.ticker.length));

  const board = el('div', 'board wideboard');
  board.innerHTML = `
    <div class="board-caption"><span class="eyebrow">BACK TEST</span><span class="strat">${res.spec.label || res.spec.type} · ${res.from}~${res.to}</span></div>
    <div class="board-cols"><div>Ticker</div><div>Verdict</div></div>
    <div class="board-rows"></div>`;
  const rowsEl = board.querySelector('.board-rows');

  rows.forEach((r) => {
    if (r.error) { rowsEl.appendChild(boardRow(r.ticker, 'c-sym', 'NO-DATA', 'c-err', '', leftW, 11)); return; }
    rowsEl.appendChild(boardRow(r.ticker, 'c-sym', r.pass ? 'QUANT' : 'NOT-QUANT', r.pass ? 'c-quant' : 'c-cut', '', leftW, 11));
  });
  rowsEl.appendChild(boardRow('TOTAL', 'c-final', `${res.summary.quant}/${res.summary.total} QUANT`, res.summary.quant ? 'c-quant' : 'c-cut', 'final ' + (res.summary.quant ? 'blue' : 'redrow'), leftW, 13));
  body.appendChild(board);

  // 수치 표(펼치기)
  const details = el('div', 'details-section');
  const btn = el('button', 'btn ghost', '수치 상세 펼치기 ▾');
  const dc = el('div', 'details hidden');
  rows.forEach((r) => dc.appendChild(simpleCard(r)));
  btn.onclick = () => { dc.classList.toggle('hidden'); btn.textContent = dc.classList.contains('hidden') ? '수치 상세 펼치기 ▾' : '접기 ▴'; };
  details.appendChild(btn); details.appendChild(dc);
  body.appendChild(details);

  animateBoard(board);
}

function simpleCard(r) {
  const card = el('div', 'ticker-card');
  if (r.error) {
    card.innerHTML = `<div class="tc-head"><span class="sym">${r.ticker}</span><span class="idx-name">${r.name || ''}</span><span class="verdict-tag fail">${r.error}</span></div>`;
    return card;
  }
  card.innerHTML = `
    <div class="tc-head">
      <span class="sym">${r.ticker}</span><span class="idx-name">${r.name || ''}</span>
      <span class="verdict-tag ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'QUANT' : 'NOT-QUANT'}</span>
    </div>
    <div class="tc-body open">
      ${metricsTable(metricRow('전략', r.strat, 'strat', r.bh) + metricRow('매수후보유', r.bh, 'bh', null))}
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

  const g = $('#prereg-grid');
  g.innerHTML =
    field('전략 타입', `<select id="f-type">${selectOpts(META.strategyTypes, type)}</select>`,
          stMeta.gridParam + ' 축을 그리드로 훑음') +
    field('MA 타입', `<select id="f-matype"><option value="sma" ${s.maType !== 'ema' ? 'selected' : ''}>SMA (단순)</option><option value="ema" ${s.maType === 'ema' ? 'selected' : ''}>EMA (지수)</option></select>`,
          '동급이면 단순한 SMA 우선') +
    field(`선택 파라미터 (${stMeta.gridParam})`, `<input id="f-chosen" type="number" step="any" value="${chosen}">`,
          '평원 중간값 — 피크 사냥 금지') +
    field('그리드 (쉼표 구분)', `<input id="f-grid" type="text" value="${grid.join(', ')}">`,
          '평원 검사가 훑는 값들') +
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
  await runSimple();
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

boot().then(() => {
  const d = new URLSearchParams(location.search).get('demo');
  if (d === 'simple') demoSimple();
  else if (d) demo();
});
