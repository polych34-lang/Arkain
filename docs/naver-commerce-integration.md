# 네이버 커머스 API 통합 노트 (ARK-3 스파이크)

**상태:** 어댑터 구현 완료 · 모킹 테스트 통과 · **라이브 검증은 자격증명 대기(블로커)**
**대상:** 네이버 스마트스토어 (네이버 커머스 API, `api.commerce.naver.com`)
**소유자:** Founding Engineer · **이슈:** ARK-3 · **날짜:** 2026-06-28

이 문서는 두 가지 목적을 가진다. (1) 두 번째 마켓(쿠팡 등)을 붙일 사람이 며칠 만에
온보딩할 수 있도록 네이버 API의 인증/쿼크/에러 처리를 기록하고, (2) ARK-3의
유일한 잔여 블로커(실 스토어 자격증명)를 CEO가 해소할 수 있게 명시한다.

---

## 1. 무엇을 만들었나 (Deliverable)

`MarketplaceAdapter` 계약을 네이버에 대해 **실제로** 구현했다. 자격증명만 들어오면
라이브로 바로 동작한다.

| 파일 | 역할 |
| --- | --- |
| `src/integrations/marketplace.ts` | 마켓 공통 계약 (주문 + **상품** 정규화 타입, `fetchProducts` 추가) |
| `src/integrations/retry.ts` | **모든** 마켓 공통 재시도/백오프 정책 (한 곳에만 존재) |
| `src/integrations/naver/naver.http.ts` | OAuth2 토큰(bcrypt 서명)·캐시·HTTP·에러 매핑 |
| `src/integrations/naver/naver.types.ts` | 네이버 원본 응답의 zod 스키마 (엣지 검증) |
| `src/integrations/naver/naver.mapper.ts` | 원본 → 정규화 (순수 함수) |
| `src/integrations/naver/naver.adapter.ts` | 어댑터 본체 (인증/주문/상품/페이지네이션) |
| `src/storage/localStore.ts` | 로컬 JSON 저장소 (멱등 upsert, DB와 동일 키) |
| `src/scripts/naver-pull.ts` | 실행 CLI: `npm run naver:pull` |
| `test/naver.test.ts` | 서명·토큰캐시·재시도·페이징·매핑 모킹 테스트 (14개 통과) |

**왜 어댑터인가 (priority #3):** 동기화 엔진과 도메인 모델은 오직 `MarketplaceAdapter`와
정규화 타입만 본다. 네이버 고유 형태는 어댑터 안에 갇혀 있다. 쿠팡은 `CoupangAdapter`
한 개를 추가하는 일이지, 코어 재작성이 아니다. 재시도 정책도 `retry.ts` 한 곳에만 있다.

---

## 2. 인증 흐름 (가장 중요한 쿼크)

네이버는 client_secret을 **그대로 보내지 않는다.** 대신 bcrypt 전자서명을 만든다.

```
password  = `${clientId}_${timestampMs}`
hashed    = bcrypt.hash(password, salt = clientSecret)   // ← secret이 bcrypt salt
signature = base64(hashed)                               // ← client_secret_sign
```

- client_secret은 네이버가 발급한 **유효한 bcrypt salt 문자열**(`$2a$...`)이다. 그래서
  bcrypt 라이브러리에 salt로 그대로 넣을 수 있다 (`bcryptjs` 의존성 추가됨).
- 토큰 발급: `POST /external/v1/oauth2/token` (form-urlencoded)
  - `client_id`, `timestamp`(ms epoch), `grant_type=client_credentials`,
    `client_secret_sign`, `type`
  - `type=SELF` — 스토어 자기 소유 앱(스크래치 스토어). client_id/secret이 그 스토어 것.
  - `type=SELLER` + `account_id` — ARKAIN이 **솔루션 제공자**일 때. 앱 키는 ARKAIN 것,
    `account_id`가 셀러를 식별. 셀러가 솔루션에 접근 권한을 부여해야 함.
- 응답: `{ access_token, expires_in(초, 보통 10800=3시간), token_type: "Bearer" }`
- 호출: `Authorization: Bearer {access_token}`

**구현 포인트:** 토큰은 `account_id` 기준으로 캐시하고 만료 60초 전에 선제 갱신한다.
토큰 발급 자체에도 레이트리밋이 있으므로 매 요청마다 재발급하면 안 된다. 우리 코드는
`NaverHttpClient`가 토큰 캐시/갱신을 자동 처리한다. 401을 받으면 캐시를 비우고
재시도 정책에 따라 한 번 재발급한다.

두 인증 모드 모두 어댑터가 지원한다. 셀러 자격증명(`secret`)에 `clientId`/`clientSecret`이
있으면 SELF, `accountId`가 있으면 SELLER로 동작한다. 앱 레벨 키는 env에서 온다.

---

## 3. 주문 가져오기 (2단계 + 시간창 페이징)

네이버 주문 API는 "변경분 조회 → 상세 조회" 2단계다.

1. **변경 상태 조회** `GET /external/v1/pay-order/seller/product-orders/last-changed-statuses`
   - `lastChangedFrom`(필수, ISO8601+오프셋), `lastChangedTo`(선택), `moreSequence`(이어보기)
   - **시간창 최대 24시간** — 더 긴 기간은 24h 창으로 쪼개 진행해야 한다.
   - 응답: `data.lastChangeStatuses[].productOrderId`, 잘렸으면 `data.more.moreSequence`
2. **상세 조회** `POST /external/v1/pay-order/seller/product-orders/query`
   - body `{ productOrderIds: [...] }` — **최대 300개/콜**
   - 응답: `data[].productOrder` + `data[].order`

**우리 어댑터의 페이징 (cursor):**
- 첫 호출: `since`부터 시작. 창 = `[from, min(from+24h, now)]`.
- `more.moreSequence`가 있으면 → 같은 창에서 `moreSequence`로 이어봄.
- 없고 창 끝 < now면 → `from = 창끝`으로 다음 창 진행.
- 둘 다 아니면 → `nextCursor` 없음(따라잡음 완료).
- 상세는 300개씩 배치 조회. cursor는 base64url JSON으로 sync 런 간 재개 가능.

**주문 granularity 쿼크:** 네이버 `orderId`(결제 1건) 안에 여러 `productOrderId`(품목,
개별 배송/취소 가능)가 있다. 우리는 `orderId` 하나를 `NormalizedOrder` 하나로 묶고,
각 productOrder를 `items[]`로 접는다. 라인 상태가 섞이면 주문 status는 `"MIXED"`로,
라인별 진실은 `raw`에 보존한다.

---

## 4. 상품 가져오기 (페이지 번호 페이징)

- `POST /external/v1/products/search` — body `{ page, size, orderType }`, **page/size 페이징**
- 응답: `contents[]`(각 `originProductNo` + `channelProducts[]`), `totalPages`
- 한 origin 상품이 여러 채널 상품(`channelProductNo`)을 가질 수 있어, 채널 상품 단위로
  `NormalizedProduct`를 펼친다. `marketplaceProductId = channelProductNo`,
  `originProductId = originProductNo`.

---

## 5. 에러 / 재시도 / 레이트리밋

- **레이트리밋:** 게이트웨이가 HTTP **429** + body code(예: `GW.RATELIMIT`)로 응답. 초당
  호출 제한이 있다. 토큰 발급도 별도 제한.
- **매핑 규칙** (`mapHttpError`): 429 · 5xx · `*RATELIMIT*` → `retryable: true`;
  4xx(401/403/400 등) → `retryable: false`. `Retry-After` 헤더(초)는 ms 백오프 힌트로.
- **재시도 정책** (`retry.ts`, 전 마켓 공통): 최대 5회, full-jitter 지수 백오프(base 500ms,
  cap 20s), 서버가 `Retry-After`를 주면 그 값을 우선. 어댑터는 재시도 루프를 직접 짜지
  않고 `MarketplaceError{retryable, retryAfterMs}`만 던진다.
- **검증:** 모든 원본 JSON은 사용 전 zod 파싱(엣지 검증). 알 수 없는 필드는
  `.passthrough()`로 보존하고, 매핑하는 필드만 필수. 금액은 정수 KRW로 round.

---

## 6. 정규화 / 정합성 규약 (ARCHITECTURE.md §6 준수)

- **금액 = 정수 KRW.** 네이버 금액은 이미 원 단위 정수. round 처리.
- **멱등 upsert:** 주문은 `(marketplace, marketplaceOrderId=orderId)`, 상품은
  `(marketplace, channelProductNo)` 키. 재실행해도 중복 집계 없음.
- **원본 보존:** 모든 정규화 레코드에 `raw` 첨부(숫자 의심 시 추적).
- **시간:** KST 타임스탬프를 ISO 8601로 정규화해 저장.
- **로컬 저장소는 임시:** `./data/naver/*.json`. ENG-Domain-Model(ARK-4)에서 Prisma
  테이블로 교체하되 어댑터/CLI는 손대지 않는다 (같은 정규화 타입 사용).

---

## 7. 실행 방법

```bash
# .env 에 스크래치 스토어 자격증명 설정 후:
#   NAVER_COMMERCE_CLIENT_ID / NAVER_COMMERCE_CLIENT_SECRET   (필수)
#   NAVER_TEST_ACCOUNT_ID   (SELLER 타입일 때만)
#   NAVER_PULL_SINCE_DAYS   (기본 14)
npm run naver:pull        # 라이브 주문+상품을 ./data/naver/ 로 적재

npm test                  # 모킹 테스트(서명/페이징/재시도/매핑) — 자격증명 불필요
```

자격증명이 없으면 CLI는 명확한 메시지와 함께 비정상 종료(코드 1)한다.

---

## 8. 잔여 블로커 — CEO 사인오프 필요 (boundary)

**코드는 완성. 라이브 검증만 자격증명에 막혀 있다.** AGENTS.md 경계상 "실 셀러
자격증명·운영 마켓 계정은 CEO 명시 승인 + 시크릿 플랜 없이 건드리지 않는다." 따라서
다음은 CEO가 풀어야 한다.

1. **네이버 커머스 API 애플리케이션 등록** — 네이버 커머스 솔루션 마켓/센터에서 ARKAIN
   앱 등록 → `client_id` + `client_secret` 발급. (SELF vs SELLER 타입 결정 필요 — §2)
2. **스크래치/테스트 스토어** — 더미 주문/상품이 있는 테스트 스마트스토어. 실 셀러
   데이터로 첫 검증을 하지 않기 위함.
3. **시크릿 전달 경로** — 키를 안전하게 전달(레포 커밋 금지). 로컬은 `.env`,
   스테이징/운영은 시크릿 매니저. ARCHITECTURE.md §7의 시크릿 플랜을 따른다.

이 세 가지가 오면 `npm run naver:pull`로 즉시 라이브 적재 → 실제 응답으로 본 문서의
쿼크(특히 §3 페이징의 `more` 형태, §5 레이트리밋 코드)를 최종 확인하고 ARK-3을 done 처리한다.
```
unblock owner: CEO  |  action: 네이버 앱 등록 + 테스트 스토어 + 시크릿 전달
```
