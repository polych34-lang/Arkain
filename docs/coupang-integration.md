# 쿠팡 Wing/Open API 통합 노트 (ARK-27)

**상태:** 어댑터 구현 완료 · 모킹 테스트 통과(17개) · **라이브 검증은 자격증명 대기(블로커)**
**대상:** 쿠팡 (Wing/Open API, `api-gateway.coupang.com`)
**소유자:** Integrations & Deployment Engineer · **이슈:** [ARK-27](/ARK/issues/ARK-27) · **날짜:** 2026-07-02

이 문서는 ARK-3(`docs/naver-commerce-integration.md`), ARK-11(`docs/esm-2.0-integration.md`)과
같은 두 가지 목적을 가진다. (1) 세 번째 마켓을 붙일 사람이 온보딩할 수 있도록 쿠팡
Wing/Open API의 인증/쿼크/에러 처리를 기록하고, (2) 잔여 블로커(실 쿠팡 WING 벤더
계정)를 CEO가 해소할 수 있게 명시한다. ESM 2.0과 같은 신뢰도 단계이므로 **§6을
반드시 먼저 읽을 것.**

---

## 1. 무엇을 만들었나 (Deliverable)

`MarketplaceAdapter` 계약을 쿠팡에 대해 구현했다. 자격증명만 들어오면 라이브로
동작하도록 설계했지만, §6의 이유로 실 응답 형태 확인 전까지는 "설계상 완성"이지
"검증된 완성"은 아니다.

| 파일 | 역할 |
| --- | --- |
| `src/integrations/marketplace.ts` | `MarketplaceId`에 `"coupang"`이 이미 예약되어 있었음(변경 없음) |
| `src/integrations/coupang/coupang.http.ts` | 요청별 HMAC(`CEA algorithm=HmacSHA256`) 서명 · HTTP 에러 매핑 |
| `src/integrations/coupang/coupang.types.ts` | 쿠팡 원본 응답의 zod 스키마 (엣지 검증, permissive) |
| `src/integrations/coupang/coupang.mapper.ts` | 원본 → 정규화 (순수 함수) |
| `src/integrations/coupang/coupang.adapter.ts` | 어댑터 본체 (인증/주문/상품/페이지네이션) |
| `src/domain/status.ts` | `COUPANG_ORDER_STATUS` / `COUPANG_PRODUCT_STATUS` 매핑 테이블 추가 |
| `src/config/env.ts`, `.env.example` | `COUPANG_*` 스크래치 CLI 환경변수 |
| `src/main.ts` | 어댑터 맵에 `coupang: new CoupangAdapter(...)` 한 줄 등록 |
| `src/scripts/coupang-pull.ts` | 실행 CLI: `npm run coupang:pull` |
| `test/coupang.test.ts` | 서명·에러매핑·페이징(상태×기간×커서)·매핑 모킹 테스트 (17개 통과) |

**왜 코어를 안 건드렸나 (priority #1, ARCHITECTURE.md §5 재확인):** 동기화 엔진·도메인
모델·재시도 정책(`retry.ts`)·`MarketplaceAdapter` 계약 중 **어느 것도 수정하지
않았다.** `MarketplaceId`(`"coupang"`)와 Prisma `Marketplace` enum(`coupang`)은
초기 스캐폴딩 때부터 이미 예약되어 있었으므로, 이번 작업은 정말로 `main.ts`의
어댑터 맵에 한 줄 추가한 것뿐이다 — 네이버(ARK-3), ESM 2.0(ARK-11)에 이은 **세
번째** 실 마켓으로 "어댑터 패턴이 일반화된다"는 ARCHITECTURE.md §5의 주장을
다시 한 번 실증했고, 이번엔 회사의 실제 2순위 타깃 마켓(쿠팡)에 대한 것이라는
점에서 이 스파이크의 원래 목적과 정확히 일치한다.

---

## 2. 인증 (가장 중요한 쿼크 — 네이버와 완전히 다름, ESM과 형태는 비슷하나 알고리즘이 다름)

네이버는 서버에 토큰을 **발급받아야** 하지만, 쿠팡은 ESM처럼 **매 요청마다** 자체
서명한 인증 헤더를 새로 만들어 보낸다(발급 왕복 없음). 다만 서명 알고리즘은 JWT가
아니라 쿠팡 고유의 HMAC 스킴(`CEA`)이다.

```
signed-date = UTC "yyMMdd'T'HHmmss'Z'"                     (예: 260702T091503Z)
message     = "{signed-date}{method}{path}{query}"
  - path: 호스트 제외, "/v2/providers/..." 형태의 경로만
  - query: 앞에 "?" 없는 raw 쿼리 문자열, key를 오름차순 정렬
            (쿠팡 공식 예제엔 멀티 파라미터 케이스가 없어, 정렬은 방어적
            기본값 — 알려진 커뮤니티 구현체들이 공통으로 채택하는 방식)
signature   = hex( HMAC-SHA256(message, secretKey) )

Authorization: CEA algorithm=HmacSHA256, access-key={accessKey},
               signed-date={signedDate}, signature={signature}
```

- `vendorId` = 쿠팡 벤더(판매자) ID.
- `accessKey` / `secretKey` = WING > 오픈API 관리에서 발급.
- **네이버와 달리 ARKAIN 앱 레벨 공유 키가 없다** — ESM과 동일하게 판매자별로
  직접 발급받은 자격증명만 존재한다. `SellerCredential.secret`에
  `vendorId`/`accessKey`/`secretKey` 세 필드가 모두 있어야 어댑터가 동작한다.
- **구현 포인트:** 만료 개념이 없어(매 요청 새로 서명) 토큰 캐싱을 하지 않는다.
  `CoupangHttpClient.sign(method, path, query)`가 이 전체를 담당한다.

---

## 3. 주문 가져오기 (상태 × 기간 × 커서, 3중 순회)

`GET /v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets`

- 쿼리: `createdAtFrom`/`createdAtTo`("yyyy-MM-dd", **최대 31일 창으로 가정 —
  공개 문서에서 명확한 상한을 재확인하지 못해 ESM과 같은 보수적 기본값 사용**),
  `status`(**"전체" 옵션을 찾지 못함** — `ACCEPT`/`INSTRUCT`/`DEPARTURE`/
  `DELIVERING`/`FINAL_DELIVERY`/`NONE_TRACKING` 중 정확히 하나가 필수로 보임),
  `maxPerPage`(최대 50), `nextToken`(커서).
- 응답: `{ code, message, nextToken, data: [ { shipmentBoxId, orderId, orderedAt,
  paidAt, status, orderer: { name }, orderItems: [...] } ] }`.

**"전체 상태" 조회 모드를 찾지 못했다** — ESM 2.0(ARK-11)이 겪은 것과 동일한
공백이다. 그래서 어댑터는 상태값 6개를 하나씩 순회하며 합친다. `fetchOrders`
한 번 호출 = API 호출 한 번(상태/기간창/커서 중 정확히 한 지점). 커서 진행 순서:

1. 현재 (상태, 기간창, `nextToken`)로 조회.
2. 응답에 `nextToken`이 있으면 → 같은 상태/기간창에서 그 토큰으로 계속.
3. 없으면 다음 상태로(토큰 리셋). 상태를 다 돌았으면 기간창을 앞으로 진행
   (최대 31일씩, 네이버의 24h/ESM의 30일 창 전진과 동일한 아이디어).
4. 기간창이 지금(now)에 도달하면 `nextCursor` 없음(따라잡음 완료).

한 발주서(`shipmentBoxId`)가 이미 배송 단위이므로, 네이버(orderId → 여러
productOrderId)처럼 분리 집계할 필요가 없다 — `NormalizedOrder` 1개 = 발주서
1개. `취소`/`반품`은 별도 문서화된 엔드포인트로 알려져 있어 이번 어댑터의
`fetchOrders`는 다루지 않는다(정상 배송 흐름 6개 상태만).

---

## 4. 상품 가져오기 (커서 페이징, 기간창 불필요)

`GET /v2/providers/seller_api/apis/api/v1/marketplace/seller-products`

- 쿼리: `vendorId`, `maxPerPage`(최대 100 가정), `nextToken`.
- 응답: `{ code, message, nextToken, data: [ { sellerProductId, sellerProductName,
  items: [ { vendorItemId, itemName, salePrice, stockQuantity, saleStatusName } ] } ] }`.

한 `sellerProductId`(마스터 등록 상품) 아래 여러 `vendorItemId`(옵션/SKU)가
올 수 있어, 각 옵션을 독립된 `NormalizedProduct`로 펼친다 — 네이버의 origin/
channel 펼치기, ESM의 사이트별 펼치기와 동일한 패턴. `originProductId`에
`sellerProductId`, `marketplaceProductId`에 `vendorItemId`를 매핑해 감사
가능하게 한다.

---

## 5. 에러 / 재시도 / 레이트리밋

공개 문서 기준으로 쿠팡은 ESM과 달리 표준 HTTP 상태코드(401 인증 실패, 404,
429 레이트리밋, 5xx)를 사용하는 것으로 보인다 — 그래서 `mapHttpError`는
ESM의 "항상 200 + 바디 코드" 방식이 아니라 네이버와 같은 HTTP 상태 기반
매핑을 따른다. 429/5xx는 재시도 가능, 4xx(인증/검증)는 영구 실패로 취급한다.
`Retry-After` 헤더가 있으면 그 값을 우선한다(초 단위 → ms 변환).

**확인 못한 것:** 엔드포인트별 정확한 rps 상한. 429 + `Retry-After` 신호에
의존하는 구조이므로, 실 계정에서 신호 형태를 확인한 뒤 필요시 튜닝한다(ESM
문서의 동일 원칙).

---

## 6. 신뢰도 캐비앗 — 반드시 읽을 것 (ESM 2.0과 같은 단계)

ARK-3(네이버)는 실 문서를 이미 확보한 상태에서 시작했다. 쿠팡은 ESM 2.0과
마찬가지로 **공개 Open API 레퍼런스만으로** 조사했고, **ARKAIN 명의의 쿠팡
WING 벤더 계정으로 단 한 번도 실제 호출을 해본 적이 없다.** 따라서:

- 엔드포인트 경로/필드명/상태값은 공개 문서 그대로 옮겼지만, 문서 자체의
  최신성·정확성은 확인 못했다.
- HMAC 서명 시 쿼리 파라미터 정렬 규칙(§2)은 알려진 커뮤니티 구현체 기반의
  방어적 가정이다 — 실 계정에서 서명 실패(401)가 나면 가장 먼저 의심할 지점.
- 기간창 상한(31일, §3)과 페이지 크기 상한(50/100, §3~4)은 다른 마켓들의
  문서화된 값에 준한 보수적 추정이다.
- "전체 상태 조회 모드 없음"(§3)도 못 찾은 것이지 없다고 확정된 것은 아니다.
- HTTP 상태코드 기반 에러 판정(§5)이 실제로 맞는지(vs. ESM처럼 바디 코드
  기반일 가능성)도 미검증이다.

**모든 원본 페이로드는 `raw`에 보존**되므로, 위 가정이 틀려도 재수집 없이
교정 가능하다(네이버·ESM과 동일 원칙, ARCHITECTURE.md §6).

---

## 7. 실행 방법

```bash
# .env 에 스크래치 셀러 자격증명 설정 후:
#   COUPANG_VENDOR_ID / COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY   (필수)
#   COUPANG_PULL_SINCE_DAYS   (기본 14)
npm run coupang:pull    # 라이브 주문+상품을 ./data/coupang/ 로 적재

npm test                 # 모킹 테스트(서명/에러매핑/페이징/매핑) — 자격증명 불필요
```

---

## 8. 잔여 블로커 — CEO 사인오프 필요 (boundary)

**코드는 완성. 라이브 검증만 자격증명에 막혀 있다** (ARK-3·ARK-11과 동일 패턴).
AGENTS.md 경계상 "실 셀러 자격증명·운영 마켓 계정은 CEO 명시 승인 + 시크릿 플랜
없이 건드리지 않는다." 다음은 CEO가 풀어야 한다:

1. **쿠팡 WING 벤더 계정 등록** — 쿠팡 판매자로 가입(입점 심사 필요).
2. **오픈API 신청/발급** — WING > 오픈API 관리 화면에서 `accessKey`/
   `secretKey` 발급. (§6 — 발급 화면에서 실제 응답 형태를 그 자리에서 확인
   가능)
3. **스크래치/테스트 스토어** — 실 셀러 데이터로 첫 검증을 하지 않기 위해
   더미 주문/상품이 있는 테스트 계정 권장(네이버·ESM과 동일 원칙).
4. **시크릿 전달 경로** — 레포 커밋 금지, ARCHITECTURE.md §7의 시크릿 플랜을
   따름.

```
unblock owner: CEO  |  action: 쿠팡 WING 벤더 계정 등록 + 오픈API 발급 + 시크릿 전달
```
