// 집행 오버레이: 전략의 원시 롱 신호(0/1) 위에 손절·익절·트레일링 스톱 + 포지션 사이징을 얹어
// 실제(무지연) 포지션 배열을 만든다. 종가 기준 판정, 이후 호출부에서 T+1 지연을 적용.
//
// exec = {
//   stopLoss, takeProfit, trailingStop: 진입가 대비 분수(0=off). 트레일링은 진입 후 최고가 대비.
//   sizing: 'full' | 'half' | 'volTarget'
//   volTarget: 목표 일간변동성(volTarget 사이징), volWindow, maxLeverage(사이징 상한, 기본 1)
// }

import { returns, rollingVol } from './indicators.js';

export function execActive(exec) {
  if (!exec) return false;
  return (exec.stopLoss > 0) || (exec.takeProfit > 0) || (exec.trailingStop > 0) || (exec.sizing && exec.sizing !== 'full');
}

export function applyExecution(closes, signal, exec) {
  const n = closes.length;
  const stopLoss = exec.stopLoss || 0, takeProfit = exec.takeProfit || 0, trailingStop = exec.trailingStop || 0;
  const sizing = exec.sizing || 'full';
  const maxLev = exec.maxLeverage || 1;
  const volTarget = exec.volTarget || 0.02;
  const vol = sizing === 'volTarget' ? rollingVol(returns(closes), exec.volWindow || 20) : null;

  const sizeAt = (i) => {
    if (sizing === 'half') return 0.5;
    if (sizing === 'volTarget') {
      const v = (vol && vol[i] != null && isFinite(vol[i]) && vol[i] > 1e-6) ? vol[i] : volTarget;
      return Math.max(0, Math.min(maxLev, volTarget / v)); // 고변동일수록 축소, maxLev 상한(기본 무레버리지)
    }
    return 1;
  };

  const pos = new Array(n).fill(0);
  let inPos = false, entryPx = 0, peak = 0, size = 0, blocked = false;

  for (let i = 0; i < n; i++) {
    const px = closes[i], sig = signal[i];
    if (inPos) {
      if (px > peak) peak = px;
      const ret = px / entryPx - 1;
      const hitStop = stopLoss > 0 && ret <= -stopLoss;
      const hitTP = takeProfit > 0 && ret >= takeProfit;
      const hitTrail = trailingStop > 0 && px <= peak * (1 - trailingStop);
      if (hitStop || hitTP || hitTrail) { inPos = false; blocked = true; pos[i] = 0; } // 스톱/익절 청산 → 신호 꺼질 때까지 재진입 차단
      else if (sig === 0) { inPos = false; pos[i] = 0; }                                 // 전략 신호 청산
      else { pos[i] = size; }
    }
    if (!inPos) {
      if (sig === 0) blocked = false;                 // 신호가 꺼지면 차단 해제
      if (sig === 1 && !blocked) { inPos = true; entryPx = px; peak = px; size = sizeAt(i); pos[i] = size; }
      else pos[i] = 0;
    }
  }
  return pos;
}
