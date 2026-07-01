# ESM 2.0 (G마켓·옥션) 통합 노트 (ARK-11)

**상태:** 어댑터 구현 완료 · 모킹 테스트 통과(16개) · **라이브 검증은 자격증명 대기(블로커)**
**대상:** G마켓 · 옥션 (ESM Trading API / "ESM 2.0", `sa2.esmplus.com`)
**소유자:** Founding Engineer · **이슈:** ARK-11 · **날짜:** 2026-07-01

이 문서는 ARK-3(`docs/naver-commerce-integration.md`)와 같은 두 가지 목적을 가진다.
(1) 세 번째 마켓을 붙일 사람이 온보딩할 수 있도록 ESM 2.0 API의 인증/쿼크/에러
처리를 기록하고, (2) 잔여 블로커(실 ESM PLUS 계정)를 CEO가 해소할 수 있게
명시한다. **추가로, ARK-3와 달리 이번엔 신뢰도 단계가 하나 더 낮다는 점을 §7에서
먼저 밝힌다 — 반드시 먼저 읽을 것.**

---

## 1. 무엇을 만들었나 (Deliverable)

`MarketplaceAdapter` 계약을 ESM 2.0에 대해 구현했다. 자격증명만 들어오면 라이브로
동작하도록 설계했지만, §7의 이유로 실 응답 형태 확인 전까지는 "설계상 완성"이지
"검증된 완성"은 아니다.

| 파일 | 역할 |
| --- | --- |
| `src/integrations/marketplace.ts` | `MarketplaceId`에 `"esm_2_0"` 추가 (기존 계약 재사용, 변경 없음) |
| `src/integrations/esm/esm.http.ts` | 요청별 JWT 서명 · HTTP + `ResultCode` 이중 에러 매핑 |
| `src/integrations/esm/esm.types.ts` | ESM 원본 응답의 zod 스키마 (엣지 검증, permissive) |
| `src/integrations/esm/esm.mapper.ts` | 원본 → 정규화 (순수 함수, 사이트별 flatten) |
| `src/integrations/esm/esm.adapter.ts` | 어댑터 본체 (인증/주문/상품/페이지네이션) |
| `src/domain/status.ts` | `ESM_ORDER_STATUS` / `ESM_PRODUCT_STATUS` 매핑 테이블 추가 |
| `src/scripts/esm-pull.ts` | 실행 CLI: `npm run esm:pull` |
| `test/esm.test.ts` | 서명·에러매핑·페이징(사이트×상태×기간×페이지)·매핑 모킹 테스트 (16개 통과) |

**왜 코어를 안 건드렸나 (priority #3, ARCHITECTURE.md §5 재확인):** 동기화 엔진·도메인
모델·재시도 정책(`retry.ts`)·`MarketplaceAdapter` 계약 중 **어느 것도 수정하지
않았다.** ESM 2.0은 `esm_2_0: new EsmAdapter(...)`를 `main.ts`의 어댑터 맵에 한 줄
추가한 것뿐이다 — 네이버 다음 두 번째 실 마켓으로 "어댑터 패턴이 일반화된다"는
ARK-3의 주장을 실증했다.

---

## 2. 설계 결정: 지마켓·옥션을 하나의 마켓플레이스로 통합

ESM PLUS는 지마켓과 옥션을 **하나의 마스터 계정**으로 묶어 운영하는 통합 셀링
플랫폼이다(윈들리 가이드 확인: "옥션 ID와 지마켓 ID는 하나의 ESM PLUS 마스터
아이디로 연결되어 있어야 함"). 그래서:

- `MarketplaceId = "esm_2_0"` **하나**로 두 스토어프론트를 모두 표현한다(별도로
  `gmarket`/`auction`을 나누지 않음) — 이슈 제목("G마켓·옥션(ESM 2.0)")과 일치.
- 주문 조회는 API 자체가 `siteType`(1=옥션, 2=지마켓)으로 스토어프론트를 구분해야
  하므로, 어댑터가 내부적으로 두 사이트를 순회한다.
- 상품 조회(`goods/search`)는 한 마스터 상품 row에 지마켓·옥션 가격/재고가 함께
  오므로, 사이트별로 `NormalizedProduct`를 하나씩 펼친다(네이버의 origin/channel
  펼치기와 동일한 패턴).
- `raw`에 항상 `site`(`"auction"`/`"gmarket"`)를 남겨 어느 스토어에서 온 데이터인지
  감사 가능하게 했다.

---

## 3. 인증 (가장 중요한 쿼크 — 네이버와 완전히 다름)

네이버는 서버에 토큰을 **발급받아야** 하지만, ESM 2.0은 **자체 서명 JWT**를 매
요청마다 새로 만들어 보낸다(발급 왕복 없음).

```
header  = { alg: "HS256", typ: "JWT", kid: masterId }
payload = { iss: clientDomain, sub: "sell", aud: "sa.esmplus.com",
            ssi: "{siteId}:{sellerId}" }   // siteId: "A"=옥션, "G"=지마켓
token   = base64url(header) + "." + base64url(payload) + "." + signature
signature = base64url( HMAC-SHA256(`${headerB64}.${payloadB64}`, secretKey) )
```//
전송: `Authorization: Bearer {token}` 헤더.

- `masterId` = ESM PLUS 마스터 ID (JWT `kid`).
- `secretKey` = 발급받은 HMAC 서명키.
- `clientDomain` = 클라이언트 도메인(JWT `iss`).
- `sellerId`는 스토어프론트별로 다르다(`auctionSellerId`/`gmarketSellerId`) — 최소
  하나는 있어야 어댑터가 동작한다(둘 다 있으면 두 스토어 모두 동기화).

**구현 포인트:** 만료(`exp`) 클레임이 문서에 없어 토큰 캐싱을 하지 않고 매 호출마다
새로 서명한다(네트워크 비용이 없으므로 무해함). `EsmHttpClient.sign(site)`가 이
전체를 담당한다.

---

## 4. 주문 가져오기 (사이트 × 상태 × 기간 × 페이지, 4중 순회)

`POST https://sa2.esmplus.com/shipping/v1/Order/RequestOrders`

- `siteType`(1=옥션/2=지마켓), `orderStatus`(**"전체" 옵션이 문서에 없음** — 1=발송대기,
  2=배송중, 3=배송완료, 4=구매확정, 5=... 문서상 코드 체계 §7 참고), `requestDateType`,
  `requestDateFrom`/`requestDateTo`("YYYY-MM-DD hh:mm", **최대 31일**), `pageIndex`,
  `pageSize`.
- 응답: `ResultCode`/`Message`/`Data.{TotalCount,PageIndex,PageSize,RequestOrders[]}`.

**"전체 상태" 조회 모드를 찾지 못했다** — 그래서 어댑터는 상태값 `[1,2,3,4,5]`를
하나씩 순회하며 합친다. `fetchOrders` 한 번 호출 = API 호출 한 번(사이트/상태/기간창/
페이지 중 정확히 한 지점). 커서 진행 순서:

1. 현재 (사이트, 상태, 기간창, 페이지)로 조회.
2. 꽉 찬 페이지(200건) → 같은 사이트/상태/기간창에서 `pageIndex + 1`.
3. 아니면 다음 상태로. 상태를 다 돌았으면 다음 사이트로. 사이트도 다 돌았으면
   기간창을 앞으로 진행(최대 30일씩, 네이버의 24h 창 전진과 동일한 아이디어).
4. 기간창이 지금(now)에 도달하면 `nextCursor` 없음(따라잡음 완료).

**알려진 비효율:** 상태를 5개 순회하므로 빈 응답 호출이 많을 수 있다. 실 계정이
생기면 "상태 미지정 = 전체" 옵션이 실제로 있는지부터 확인해 이 루프를 줄일 것.

---

## 5. 상품 가져오기 (페이지 번호 페이징, 사이트 순회 불필요)

`POST https://sa2.esmplus.com/item/v1/goods/search` — `pageIndex`/`pageSize`(최대
500), 응답 `{ totalItems, items: [{ goodsNo, goodsName, price:{gmkt,iac},
stock:{gmkt,iac}, sellStatus:{gmkt,iac}, siteGoodsNo:{gmkt,iac} }] }`. 한 행에 두
스토어 정보가 함께 오므로 §2처럼 사이트별로 펼친다. 서명은 편의상 설정된 사이트 중
첫 번째로 한다 — **가정**: 마스터 계정 하나로 서명하면 어느 사이트로 서명해도 같은
통합 상품 목록이 조회된다는 전제인데, 실 계정 확인 전까지는 검증되지 않았다.

---

## 6. 에러 / 재시도 / 레이트리밋 (네이버와 다른 응답 형태)

찾은 모든 문서에서 HTTP는 **항상 200**이고, 성공/실패는 바디의 `ResultCode`(0=성공)/
`Message`로 판단한다 — 네이버처럼 HTTP 429/4xx로 구분하지 않는다. 확인된 유일한
레이트리밋: **주문조회 API는 셀러ID당 5초에 1회**(2025-04-23 공지,
https://etapi.gmarket.com/198), 초과 시 `"...5초당 1회 호출 가능합니다. 잠시 후
다시 시도해 주세요."` 메시지가 온다.

- `mapResultError`: 메시지에 `초당`/`잠시 후 다시`/`다시 시도`가 있으면
  `retryable: true`(+ 5초 백오프 힌트), 그 외 비-0 `ResultCode`는 **영구 실패**로
  취급한다. **이건 확정된 에러코드 체계가 아니라 관찰된 패턴 기반 추정이다** — 실
  계정으로 실제 `ResultCode` 목록을 확인하기 전까지는 재시도 판정이 틀릴 수 있음.
- `mapHttpError`: 혹시 실제로 HTTP 상태코드를 쓰는 엔드포인트가 있을 경우를 대비해
  429/5xx는 retryable로 방어적으로 유지(네이버와 동일 관례).
- 상품 목록 조회는 분당 30회 제한(공식 문서 언급) — 아직 어댑터에 별도 스로틀은
  넣지 않았다(재시도 정책이 429/레이트리밋 신호를 받으면 처리하는 구조이므로,
  실 계정에서 이 신호 형태를 확인한 뒤 필요시 튜닝).

---

## 7. 신뢰도 캐비앗 — 반드시 읽을 것 (ARK-3보다 한 단계 낮은 확신)

ARK-3(네이버)는 실 문서를 이미 확보한 상태에서 시작했다. ESM 2.0은 **이번에 처음
공개 문서를 조사**했다 (`etapi.gmarket.com`, `developer.auction.co.kr`,
`guide.windly.cc` 등 — 이슈 코멘트에 링크 첨부). 조사로 얻은 정보는 실제 API
레퍼런스 페이지에서 나온 것이라 완전 추측은 아니지만, **ARKAIN 명의의 ESM PLUS
계정으로 단 한 번도 실제 호출을 해본 적이 없다.** 따라서:

- 엔드포인트 경로/필드명/상태코드는 공개 문서 그대로 옮겼지만, 문서 자체의 최신성·
  정확성은 확인 못했다.
- `ResultCode` 재시도 판정(§6)은 관찰된 메시지 패턴에 기반한 추정이다.
- 상품 조회 시 사이트 간 서명 무관성(§5)은 검증되지 않은 가정이다.
- "전체 상태 조회 모드 없음"(§4)도 못 찾은 것이지 없다고 확정된 것은 아니다.

**모든 원본 페이로드는 `raw`에 보존**되므로, 위 가정이 틀려도 재수집 없이 교정
가능하다(네이버와 동일 원칙, ARCHITECTURE.md §6).

---

## 8. 실행 방법

```bash
# .env 에 스크래치 셀러 자격증명 설정 후:
#   ESM_MASTER_ID / ESM_SECRET_KEY / ESM_CLIENT_DOMAIN   (필수)
#   ESM_GMARKET_SELLER_ID, ESM_AUCTION_SELLER_ID          (최소 1개 필수)
#   ESM_PULL_SINCE_DAYS   (기본 14)
npm run esm:pull        # 라이브 주문+상품을 ./data/esm/ 로 적재

npm test                 # 모킹 테스트(서명/에러매핑/페이징/매핑) — 자격증명 불필요
```

---

## 9. 잔여 블로커 — CEO 사인오프 필요 (boundary)

**코드는 완성. 라이브 검증만 자격증명에 막혀 있다** (ARK-3와 동일 패턴).
AGENTS.md 경계상 "실 셀러 자격증명·운영 마켓 계정은 CEO 명시 승인 + 시크릿 플랜
없이 건드리지 않는다." 다음은 CEO가 풀어야 한다 — 별도 이슈로 에스컬레이션함
(본문 코멘트의 링크 참고):

1. **ESM PLUS 마스터 계정 등록** — 지마켓/옥션 셀러로 가입 후 ESM PLUS에서 두
   스토어를 하나의 마스터 ID로 연결.
2. **오픈API 신청/발급** — ESM PLUS 관리 화면에서 API 키(masterId + secretKey +
   clientDomain) 발급. (§7 — 발급 화면에서 실제 응답 형태를 그 자리에서 확인 가능)
3. **스크래치/테스트 스토어** — 실 셀러 데이터로 첫 검증을 하지 않기 위해 더미
   주문/상품이 있는 테스트 계정 권장(네이버와 동일 원칙).
4. **시크릿 전달 경로** — 레포 커밋 금지, ARCHITECTURE.md §7의 시크릿 플랜을 따름.

~~또한 (별도 트랙, CEO 액션 아님): **ARK-10**(멀티테넌시 마이그레이션)이 현재
`prisma/schema.prisma`의 `Marketplace` enum을 동시에 수정 중이라, 이번 작업에서는
그 파일을 건드리지 않았다. ARK-10이 끝나면 `Marketplace` enum에 `esm_2_0`을
추가하는 한 줄짜리 후속 작업이 필요하다(그 전까지는 ESM 2.0 커넥션을 실제 DB에
동기화할 수 없음 — 어댑터/테스트는 로컬 JSON 스토어로 완전히 검증됨).~~

**해결됨 (ARK-20):** ARK-10 커밋(e93d233)이 `Marketplace` enum에 `esm_2_0`을
함께 포함시켜 머지되었다. 이 값은 아직 어떤 실 DB에도 적용된 적 없는 최초
마이그레이션(`20260701000000_init_domain_model`)의 `CREATE TYPE` 문에 이미
들어 있으므로, 별도의 ALTER TYPE 마이그레이션은 필요 없다. `npm run typecheck`
통과 확인됨. 남은 블로커는 여전히 위 1~4번(CEO의 ESM PLUS 계정/자격증명)뿐이다.

```
unblock owner: CEO  |  action: ESM PLUS 마스터 계정 등록 + 오픈API 발급 + 시크릿 전달
```
