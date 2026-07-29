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
