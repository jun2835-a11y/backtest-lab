// 데이터 계층: Yahoo Finance(무료, 서버사이드 조회) + 인메모리 캐시 + 3배 합성 재구성.
//
// 실데이터(관문①)는 상장된 ETF 일봉을 그대로 쓴다.
// 합성데이터(관문②, "잃어버린 10년")는 ETF가 존재하지 않던 시기를 커버하기 위해
// 기초지수에 3배 일간복리 + 운용보수·차입비용 드래그를 적용해 재구성한다.

const DAY = 86400;

// ETF → 기초지수/운용보수 매핑. financing = 연 차입 스프레드(레버리지 2배분에 부과).
export const UNIVERSE = {
  TQQQ: { name: '나스닥100 3x',   index: '^NDX',  leverage: 3, expense: 0.0084, financing: 0.010 },
  SOXL: { name: '반도체 3x',       index: '^SOX',  leverage: 3, expense: 0.0076, financing: 0.010 },
  UPRO: { name: 'S&P500 3x',       index: '^GSPC', leverage: 3, expense: 0.0091, financing: 0.010 },
  TNA:  { name: '러셀2000 3x',     index: '^RUT',  leverage: 3, expense: 0.0110, financing: 0.010 },
  LABU: { name: '바이오텍 3x',     index: '^NBI',  leverage: 3, expense: 0.0100, financing: 0.010 },
};

export const TICKERS = Object.keys(UNIVERSE);

const cache = new Map(); // key -> { at, bars }
const TTL_MS = 6 * 60 * 60 * 1000; // 6시간

function isoToTs(iso) {
  return Math.floor(new Date(iso + 'T00:00:00Z').getTime() / 1000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (backtest-lab)' }, signal: ac.signal });
  } finally { clearTimeout(timer); }
}

// Yahoo v8 chart API에서 조정종가 일봉. 타임아웃·재시도·호스트 폴백으로 견고화. → [{t, iso, close}]
async function fetchYahoo(symbol, period1, period2) {
  const enc = encodeURIComponent(symbol);
  const path = `/v8/finance/chart/${enc}?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplit`;
  const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  const ATTEMPTS = 3, TIMEOUT = 12000;
  let lastErr;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const host = hosts[attempt % hosts.length]; // 호스트 폴백(query1↔query2)
    try {
      const res = await fetchWithTimeout(host + path, TIMEOUT);
      if (res.status === 429 || res.status >= 500) { // 레이트리밋/서버오류 → 백오프 재시도
        lastErr = new Error(`Yahoo ${symbol} HTTP ${res.status}`);
        await sleep(400 * (attempt + 1)); continue;
      }
      if (res.status === 404) throw new Error(`종목 '${symbol}'을(를) 찾지 못했습니다(심볼 확인).`);
      if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      if (!r || !r.timestamp) throw new Error(`'${symbol}': 데이터 없음(심볼/기간 확인).`);
      const ts = r.timestamp;
      const adj = r.indicators?.adjclose?.[0]?.adjclose; // 조정종가 우선(배당·분할 반영)
      const close = r.indicators?.quote?.[0]?.close;
      const px = adj || close;
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        const c = px[i];
        if (c == null || !isFinite(c)) continue;
        bars.push({ t: ts[i], iso: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
      }
      bars.name = r.meta?.shortName || r.meta?.symbol || symbol;
      bars.currency = r.meta?.currency || '';
      return bars;
    } catch (e) {
      lastErr = e;
      if (/찾지 못했|데이터 없음/.test(e.message)) throw e; // 영구 오류는 재시도 안 함
      if (attempt < ATTEMPTS - 1) { await sleep(400 * (attempt + 1)); continue; }
    }
  }
  const aborted = lastErr && lastErr.name === 'AbortError';
  throw new Error(aborted ? `'${symbol}' 응답 시간 초과(네트워크/야후 지연).` : (lastErr?.message || `Yahoo ${symbol} 실패`));
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.bars;
  const bars = await loader();
  cache.set(key, { at: Date.now(), bars });
  return bars;
}

// 실데이터 ETF 일봉(조정종가).
export async function getReal(ticker, from, to) {
  const p1 = isoToTs(from), p2 = isoToTs(to);
  const bars = await cached(`real:${ticker}:${from}:${to}`, () =>
    fetchYahoo(ticker, p1, p2));
  return bars;
}

// 자유 모드: 임의 Yahoo 종목(주식·ETF·지수·코인·환율) 일봉 + 종목명.
export async function getFree(ticker, from, to) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (!sym) throw new Error('빈 종목');
  const p1 = isoToTs(from), p2 = isoToTs(to);
  const bars = await cached(`free:${sym}:${from}:${to}`, () => fetchYahoo(sym, p1, p2));
  return { ticker: sym, name: bars.name || sym, bars };
}

// 지수 일봉으로부터 3배 합성 시계열을 재구성.
// 시작 100으로 정규화한 가상 ETF 가격.
export async function getSynthetic(ticker, from, to) {
  const u = UNIVERSE[ticker];
  if (!u) throw new Error(`알 수 없는 종목: ${ticker}`);
  const p1 = isoToTs(from), p2 = isoToTs(to);
  const idx = await cached(`idx:${u.index}:${from}:${to}`, () =>
    fetchYahoo(u.index, p1, p2));
  if (idx.length < 2) throw new Error(`${u.index}: 합성용 데이터 부족`);

  const dailyDrag = (u.expense + u.financing * (u.leverage - 1)) / 252;
  const out = [{ t: idx[0].t, iso: idx[0].iso, close: 100 }];
  for (let i = 1; i < idx.length; i++) {
    const r = idx[i].close / idx[i - 1].close - 1;
    const lev = u.leverage * r - dailyDrag;
    const prev = out[i - 1].close;
    out.push({ t: idx[i].t, iso: idx[i].iso, close: prev * (1 + lev) });
  }
  return out;
}

// 히스토릭 구간 정의 — 이중 관문에 쓰이는 표본들.
// QE 실데이터는 상장 이후만 존재하므로 전·후반으로 분할한다.
export const REGIMES = {
  qe_full:   { label: 'QE 실데이터 전체',   source: 'real', from: '2011-01-01', to: '2025-12-31' },
  qe_first:  { label: 'QE 전반(2011~2017)', source: 'real', from: '2011-01-01', to: '2017-12-31' },
  qe_second: { label: 'QE 후반(2018~2025)', source: 'real', from: '2018-01-01', to: '2025-12-31' },
  lost:      { label: '잃어버린 10년(닷컴·2000~2010, 3배 합성)', source: 'synthetic', from: '2000-01-01', to: '2010-12-31' },
};

// 리짐 하나에 대한 종목 시계열 로드.
export async function getSeries(ticker, regimeKey) {
  const rg = REGIMES[regimeKey];
  if (!rg) throw new Error(`알 수 없는 리짐: ${regimeKey}`);
  const bars = rg.source === 'real'
    ? await getReal(ticker, rg.from, rg.to)
    : await getSynthetic(ticker, rg.from, rg.to);
  return { ticker, regime: regimeKey, source: rg.source, label: rg.label, bars };
}
