# 네이버 SELLER(솔루션 제공자) 셀프서비스 연동 — ARK-21

**상태:** 코드 완성 · 유닛/라우트 테스트 통과 · **셀러의 실제 "연결 허용" 클릭은 사람 전제
블로커(SellerDesk 솔루션 등록) 대기**
**부모 이슈:** ARK-3 (Naver Smart Store spike) · **관련 문서:** `docs/seller-onboarding-naver.md`
(§7이 이 작업의 원 제안), `docs/naver-commerce-integration.md` (어댑터 인증 쿼크)

## 1. 무엇이 바뀌었나

ARK-3의 SELF 방식은 셀러가 커머스 API센터에서 앱을 직접 등록해야 해 온보딩 마찰이 컸다.
이 이슈는 진짜 저마찰 셀프서비스인 **SELLER 모델**을 코드로 구현한다: 셀러는 앱을 만들지
않고, `account_id`만 SellerDesk에 전달하면 된다. 앱 키(`client_id`/`client_secret`)는
ARKAIN(SellerDesk) 소유이며 이미 env로 설정돼 있다 — `naver.adapter.ts`/`naver.http.ts`는
ARK-3 때부터 SELF/SELLER 두 모드를 모두 지원했으므로 **코어 변경은 전혀 없다.**

## 2. 새로 만든 것

| 파일 | 역할 |
| --- | --- |
| `src/connect/naverSellerConnect.ts` | `connectNaverSeller()` — accountId를 받아 `adapter.verifyCredential`로 먼저 검증하고, 통과해야만 `credentialStore.put` + `store.upsertConnection`으로 저장. 검증 실패(잘못된 accountId)는 값으로 반환하고, 네트워크/5xx 같은 일시 오류는 그대로 던져 "무효"와 혼동하지 않는다. |
| `src/domain/repository.ts` — `upsertConnection` / `listConnectionSummaries` | `(sellerId, marketplace)` unique 키로 upsert(재연동 = 같은 API 재호출), 최근 `SyncRun` 1건을 조인해 관리 화면에 상태를 보여준다. |
| `POST /api/connections/naver/connect` | `{ tenantId, accountId }` → 검증 성공 시 `{ connectionId }`, 실패 시 422 + 한글 에러 메시지. DB/키 미설정이면 503. |
| `GET /api/connections?tenantId=` | 해당 셀러의 연동 목록 + 상태 + 마지막 동기화 시각/결과. |
| `GET /onboarding/naver` | 5스텝 온보딩 마법사(§7 원안 매핑). `NAVER_SELLER_CONSENT_URL` 설정 시 "네이버에서 연결 허용하기" 버튼, 미설정 시 계정 ID 수동 입력 폴백으로 정직하게 표시. |
| `GET /connections` | 연동 상태/재연동 관리 화면. "재연동" = 온보딩 마법사로 다시 진입(멱등 upsert이므로 안전). |

## 3. 5스텝 매핑 (§7 원안 그대로)

1. 준비물 (네이버 커머스 계정 + 스마트스토어 1개)
2. 네이버 로그인 → SellerDesk 연결 허용 (외부 딥링크, `NAVER_SELLER_CONSENT_URL`)
3. 계정 ID 확인 (콜백 쿼리 `?accountId=`가 있으면 자동 채움, 없으면 수동 입력)
4. 저장 (`POST /api/connections/naver/connect`)
5. 연동 확인 & 첫 동기화 (검증 성공 시 자동으로 `/api/sync/run` 호출)

## 4. 잔여 블로커 — 사람 전제 (에이전트 불가)

**코드는 완성. "연결 허용" 버튼이 실제 네이버 화면으로 연결되려면 SellerDesk가 네이버
커머스 솔루션 제공자로 등록/심사를 통과해야 한다.** 이는 사업자 명의·법무 단계이며
AGENTS.md 경계상 에이전트가 대신할 수 없다.

- **등록 전:** `NAVER_SELLER_CONSENT_URL`이 비어 있고, 온보딩 UI는 계정 ID 수동 입력
  폴백을 보여준다(가짜 URL을 채워넣지 않음 — ARK-3에서 크리덴셜을 조작하지 않은 것과
  같은 원칙).
- **등록 후 남는 작업 (사람):** 네이버가 확정한 콜백 파라미터 이름(예: `account_id` vs
  `accountId`) 확인 후 `renderNaverOnboarding`의 콜백 파싱과 1줄 맞추고,
  `NAVER_SELLER_CONSENT_URL`을 실제 딥링크로 설정.
- 그 전까지도 계정 ID를 미리 안다면(예: 지원팀이 셀러에게 안내받은 경우) 3~4단계 수동
  입력 경로로 오늘도 연동을 완료할 수 있다 — 이 경로는 이미 라이브다.

```
unblock owner: 보드/실사용자  |  action: 네이버 커머스 솔루션 제공자 등록/심사 통과 후
NAVER_SELLER_CONSENT_URL 설정
```
