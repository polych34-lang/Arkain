# GS샵 주문 엑셀 임포트 (ARK-46)

**상태:** 파이프라인 구현 완료 · 단위/통합 테스트 통과 · **실 엑셀 샘플로는 미검증(블로커)**
**대상:** GS샵(舊 GS홈쇼핑) 파트너스 포털 "주문리스트" 엑셀 다운로드
**소유자:** Founding Engineer · **이슈:** ARK-46 (ARK-15 스파이크의 후속) · **날짜:** 2026-07-03

이 문서는 ARK-15 스파이크(`docs/tv-homeshopping-integration-spike.md` §3(a)/§5)가
"CEO 결정 필요"로 남겨둔 GS샵 엑셀 임포트를 실제로 구현한 결과다. §5.2가 제안한
순서("오픈마켓 어댑터가 어느 정도 자리잡은 뒤")대로, ARK-27(쿠팡)까지 어댑터 3개가
자리잡은 시점에 ARK-46으로 배정됐다 — 이 배정 자체가 "엑셀 임포트를 MVP 스코프에
넣는다"는 board 결정의 실행으로 간주하고 진행했다. ARCHITECTURE.md의 해당 문장도
이 문서를 가리키도록 갱신했다.

---

## 1. 왜 어댑터가 아니라 별도 컴포넌트인가

ARK-15 §3(a)의 결론을 그대로 따른다: GS샵 파트너스 포털은 공개 주문 API가 없다
(있다 해도 로그인 후 문서라 이번 조사로는 확인 불가). `MarketplaceAdapter.
fetchOrders`가 전제하는 "실시간 원격 호출"이 아예 없으므로, 계약을 "가짜
fetchOrders"로 억지로 흉내 내지 않고 `src/imports/gsshop/`을 독립 컴포넌트로 뒀다.

대신 마지막 산출물은 다른 어댑터와 똑같은 `NormalizedOrder[]`다 — 그래서
`PrismaDomainStore.upsertOrders`(멱등 upsert, `(tenantId, marketplace,
marketplaceOrderId)` 키)를 그대로 재사용한다. 저장 계층이 두 개로 갈라지지 않는다.

| 파일 | 역할 |
| --- | --- |
| `src/imports/gsshop/gsshop.types.ts` | 캐노니컬 필드의 zod 행(row) 스키마, 헤더 별칭 테이블, 포맷/행 에러 타입 |
| `src/imports/gsshop/gsshop.mapper.ts` | 검증된 행 → `NormalizedOrder[]` (순수 함수, `naver.mapper.ts`와 같은 "동일 주문번호 여러 줄 -> 하나의 주문" 그룹핑) |
| `src/imports/gsshop/gsshopExcelParser.ts` | I/O 경계: `.xlsx` 버퍼(exceljs) → 헤더 매칭 → 행별 검증 → `{ orders, rowErrors, rowsRead }` |
| `src/web/gsshopImport.ts` | 업로드 화면 (서버렌더 HTML + vanilla JS, `ordersDashboard.ts`와 같은 톤) |
| `src/app.ts` | `GET /imports/gsshop`, `POST /api/imports/gsshop` (multipart, `@fastify/multipart`) |
| `test/gsshop-import.test.ts` | 매퍼 + 파서 + 라우트 테스트 (12개) |

---

## 2. MVP 스코프 판단

이슈 설명이 "MVP 스코프 판단 필요"라고 명시했다 — 아래가 그 판단이다.

**포함:**
- 셀러가 직접 `.xlsx` 파일을 업로드(수동, 1건씩). 스케줄러/폴링 없음 — ARK-15 §4가
  이미 "신규 스케줄러/폴링 없음, 오히려 어댑터보다 단순"이라고 추정한 그대로.
- 헤더 텍스트 기반 컬럼 매칭(고정 위치 아님) + 별칭 목록 — 포털이 컬럼 순서를
  바꿔도 웬만하면 깨지지 않는다.
- **부분 성공.** 한 행이 깨져도(빈 셀, 숫자 변환 실패) 배치 전체를 막지 않고 그
  행만 건너뛰고 사유를 반환한다 — 나머지 정상 행은 정상 임포트.
- **전체 실패는 큰 소리로.** 필수 컬럼이 아예 안 잡히면(엑셀 자체가 다른 파일)
  즉시 `422`로 실패시킨다 — 잘못된 파일을 조용히 이상하게 파싱해 틀린 숫자를
  만드는 쪽보다 훨씬 안전하다(AGENTS.md 우선순위 #2: 셀러 데이터 정확성).
- 기존 오픈마켓과 같은 주문 대시보드(`/orders`, `/api/orders?marketplace=gsshop`)에
  바로 나타난다 — 새 UI를 만들지 않았다.

**포함하지 않음(의도적으로):**
- **포털 스크레이핑/RPA.** ARK-15 §3(b)/§5.3이 이미 기본값으로 비권장 처리했다
  (ToS 리스크 + ARCHITECTURE.md §7의 셀러 자격증명 경계). 이 이슈에서도 다시
  검토하지 않았다.
- **정산(Settlement) 매핑.** ARK-15 §2.4가 지적한 대로 TV홈쇼핑 정산 구조가
  오픈마켓과 다르다 — `docs/accounting-module.md`(ARK-38/39) 쪽 후속 이슈로 남긴다.
  이번 임포트는 주문만 만든다.
- **자동 스케줄링/이메일 폴링(예: 포털이 엑셀을 메일로도 보내주는 경우).** 실제로
  그런 경로가 있는지조차 미확인 — 확인되면 별도 이슈.

---

## 3. 블로커 — 실 엑셀 샘플 미확보

ARK-15 §6이 이미 밝힌 한계를 그대로 물려받는다: **GS샵 파트너스에 로그인해서 실제
"주문리스트" 엑셀을 내려받아 본 적이 없다.** 아래 컬럼 스키마는 GS샵 파트너스
공개 정보 + 업계 통상 "주문리스트 다운로드" 관행에 근거한 최선의 추정이다(다른
채널 어댑터들이 API 응답 필드에 확신을 가진 것과 다른 수준의 신뢰도).

| 캐노니컬 필드 | 허용 헤더(별칭) | 필수 |
| --- | --- | --- |
| `orderNo` | 주문번호 | ✅ |
| `orderedAt` | 주문일시, 주문일자, 결제일시 | ✅ |
| `status` | 주문상태, 처리상태 | ✅ |
| `productName` | 상품명 | ✅ |
| `quantity` | 수량, 주문수량 | ✅ |
| `amountKrw` | 상품금액, 결제금액, 합계금액, 정산금액 | ✅ |
| `buyerName` | 수취인명, 수취인, 주문자명, 고객명 | (선택) |
| `productCode` | 상품코드, 상품번호, 옵션코드 | (선택) |

설계로 이 리스크를 흡수한 지점:
- **헤더는 텍스트 매칭 + 별칭** — 컬럼 순서/정확한 문구가 조금 달라도 버틴다.
- **필수 컬럼이 하나도 안 잡히면 즉시 실패**(`GsShopFormatError`, 422) — "그럴듯하지만
  틀린" 파싱을 만들지 않는다.
- **`raw`에 원본 행을 통째로 보존** — 매핑이 틀렸다고 판명나도 재업로드 없이
  `gsshop.mapper.ts`/`status.ts`만 고치면 교정된다(네이버 어댑터와 같은 패턴).
- **주문상태 매핑(`domain/status.ts`의 `GSSHOP_ORDER_STATUS`)도 같은 이유로 추정치** —
  값 목록 자체가 실 파일 없이 만든 추정이다. 매핑에 없는 값은 `UNKNOWN`으로
  떨어지고 `rawStatus`는 그대로 보존되므로 잘못 버킷팅돼도 나중에 고칠 수 있다.

**필요한 조치 (CEO/board):** 실제 GS샵 파트너스 계정에서 "주문리스트" 엑셀을 한 건
내려받아 전달해주면, 위 헤더 표와 상태값 매핑을 실물로 교정하고 이 문서의 상태를
"실 샘플로 검증 완료"로 올린다. 계정/로그인 자체가 없다면 — ARK-15와 같은 종류의
블로커이므로 같은 방식으로(CEO가 입점/계정 여부를 확인) 풀어야 한다.

---

## 4. 사용법

1. `/imports/gsshop`에서 셀러 ID + 엑셀 파일 업로드, 또는
   `POST /api/imports/gsshop` (multipart: `tenantId`, `file`).
2. 응답: `{ ordersImported, totalOrders, rowsRead, rowErrors }`.
   `rowErrors`는 건너뛴 행과 사유 — 화면에 그대로 노출해 셀러가 원본 엑셀을
   고쳐 재업로드할 수 있게 한다.
3. 성공한 주문은 `/orders`, `/api/orders?marketplace=gsshop`에 다른 마켓과 함께
   나타난다. 재업로드는 `(tenantId, marketplace, marketplaceOrderId)` upsert라
   안전하다(중복 생성 없음).

## 5. 다음 단계

- CEO: 실 엑셀 샘플 확보(§3) — 이게 유일한 잔여 블로커.
- 후속(별도 이슈, 지금 스코프 아님): 정산 매핑, CJ온스타일/현대홈쇼핑 어댑터
  (ARK-15 §5.1이 1순위로 추천).
