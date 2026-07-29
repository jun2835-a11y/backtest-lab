# 백테스트 검증 랩 (backtest-lab)

자연어로 레버리지 ETF 전략을 던지면 **사전등록 → 이중 관문 → 평원 → 다종목 → 판정**의
채택/기각 프로토콜로 백테스트하는 독립 사이트. 바이브 트레이딩과 무관.

## 검증 프로토콜

- **사전등록** — 돌리기 전에 그리드·통과선·평원 임계·과반을 잠근다. 잠근 뒤 변경 = 과적합(UI가 경고).
- **이중 관문** — ① QE 실데이터(전·후반 분할) 무훼손 **AND** ② 잃어버린 10년(닷컴 3배 합성) 무훼손. 한쪽만은 기각.
- **평원** — 파라미터 그리드에서 고립 피크는 기각. 선택값은 이웃이 안정적인 평원 안이어야.
- **다종목** — TQQQ·SOXL·UPRO·TNA·LABU 중 3개 이상 통과해야 채택.
- **판정원칙** — 칼마 10% 내면 수익 우선 · 동급이면 단순한 쪽 · 사전확률에 비례한 회의.

## 데이터

Yahoo Finance 조정종가(무료, 서버사이드 조회, 키 불필요).
관문②의 "잃어버린 10년"은 실 ETF가 없던 2000~2010을 커버하기 위해 기초지수
(`^NDX ^SOX ^GSPC ^RUT ^NBI`)에 **3배 일간복리 + 운용보수·차입비용 드래그**를 적용한 합성 시계열.

| ETF | 기초지수 | 운용보수 |
|---|---|---|
| TQQQ | ^NDX (나스닥100) | 0.84% |
| SOXL | ^SOX (반도체) | 0.76% |
| UPRO | ^GSPC (S&P500) | 0.91% |
| TNA | ^RUT (러셀2000) | 1.10% |
| LABU | ^NBI (나스닥 바이오텍) | 1.00% |

## 실행

```bash
npm install
# (선택) 자연어 파싱에 Claude 사용
export ANTHROPIC_API_KEY=sk-ant-...   # 없으면 키워드 폴백 파서로 동작
npm start        # http://localhost:8787
npm test         # 순수 로직 테스트(네트워크 불필요)
```

## Render 배포

리포를 GitHub에 올린 뒤 Render에서 `render.yaml` 감지 → **환경변수 `ANTHROPIC_API_KEY`만 대시보드에서 설정**.
`buildCommand: npm install`, `startCommand: npm start`, 포트는 Render가 자동 주입.

## 구조

```
server.js          Express: 정적 서빙 + /api/parse + /api/backtest + /api/meta
src/data.js        Yahoo 조회 + 캐시 + 3배 합성 재구성 + 리짐 정의
src/indicators.js  SMA/EMA/변동성/낙폭
src/strategy.js    전략 타입(ma_timing/dual_ma/vol_target) → 포지션 신호
src/backtest.js    자산곡선 + CAGR/MDD/칼마/샤프
src/protocol.js    사전등록·이중관문·평원·다종목·판정 (핵심)
src/parse.js       자연어 → 사전등록 스펙 (Claude / 키워드 폴백)
public/            검증 콘솔 UI
```

백테스트는 미래 수익을 보장하지 않는다. 합성 구간은 근사치다.
