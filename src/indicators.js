// 지표 계산 — 전략 신호에 쓰이는 최소 집합. 모두 종가 배열(number[]) 입력.

// 단순이동평균. 데이터 부족 구간은 null.
export function sma(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// 지수이동평균.
export function ema(closes, period) {
  const out = new Array(closes.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < closes.length; i++) {
    if (prev == null) {
      // 초기값은 period 시점의 SMA로 시드.
      if (i >= period - 1) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += closes[j];
        prev = s / period;
        out[i] = prev;
      }
    } else {
      prev = closes[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// 일간수익률(로그 아님, 산술). out[0] = 0.
export function returns(closes) {
  const out = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) out[i] = closes[i] / closes[i - 1] - 1;
  return out;
}

// 롤링 변동성(표준편차, 연율화 아님). 부족 구간 null.
export function rollingVol(rets, period) {
  const out = new Array(rets.length).fill(null);
  for (let i = period - 1; i < rets.length; i++) {
    let m = 0;
    for (let j = i - period + 1; j <= i; j++) m += rets[j];
    m /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (rets[j] - m) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

// 널을 건너뛰는 시리즈 EMA(MACD 시그널용).
function emaSeries(series, period) {
  const out = new Array(series.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null, warm = [];
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v == null) continue;
    if (prev == null) {
      warm.push(v);
      if (warm.length === period) { prev = warm.reduce((a, b) => a + b, 0) / period; out[i] = prev; }
    } else { prev = v * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}

// RSI(와일더). 0~100.
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) { gain /= period; loss /= period; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

// MACD → {line, signal, hist}.
export function macd(closes, fast = 12, slow = 26, signalP = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  const signal = emaSeries(line, signalP);
  const hist = line.map((v, i) => (v != null && signal[i] != null) ? v - signal[i] : null);
  return { line, signal, hist };
}

// 볼린저 밴드 → {mid, upper, lower}.
export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

// 롤링 최고/최저(종가 기준 — 조정종가만 있어 고저 대용).
export function rollingHigh(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) if (closes[j] > m) m = closes[j];
    out[i] = m;
  }
  return out;
}
export function rollingLow(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) if (closes[j] < m) m = closes[j];
    out[i] = m;
  }
  return out;
}

// 모멘텀(변화율, %). out[i] = closes[i]/closes[i-period] - 1.
export function roc(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) out[i] = closes[i] / closes[i - period] - 1;
  return out;
}

// 전고점 대비 낙폭(양수 = 하락률).
export function drawdownFromPeak(closes) {
  const out = new Array(closes.length).fill(0);
  let peak = -Infinity;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] > peak) peak = closes[i];
    out[i] = peak > 0 ? 1 - closes[i] / peak : 0;
  }
  return out;
}
