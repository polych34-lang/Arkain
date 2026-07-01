/**
 * ARK-21: 네이버 SELLER(솔루션 제공자) 셀프서비스 온보딩 — 5스텝 마법사.
 * Steps map to docs/seller-onboarding-naver.md §7's UI mapping, adapted from
 * the SELF guide's 5 steps to the lower-friction SELLER flow: no app
 * registration, just 로그인 → 연결 허용 → (계정 ID 확인) → 저장 → 첫 동기화.
 *
 * `consentUrl` is the deep link to Naver's solution-consent screen. It stays
 * undefined until SellerDesk's own solution-provider registration is
 * approved (a business/legal step, tracked outside this issue) — until then
 * the UI is honest about that gap and offers the manual account-id fallback
 * instead of a fabricated link.
 */
export function renderNaverOnboarding(opts: { consentUrl?: string } = {}): string {
  const { consentUrl } = opts;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 네이버 스마트스토어 연동</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, "Malgun Gothic", sans-serif; margin: 2rem auto; max-width: 640px; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  .step { border: 1px solid #e2e2e2; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .step h2 { font-size: 1rem; margin: 0 0 0.5rem; }
  .step p { color: #444; font-size: 0.9rem; line-height: 1.5; }
  .step.done { border-color: #2e7d32; background: #f3f9f3; }
  label { display: block; font-size: 0.85rem; color: #444; margin-top: 0.5rem; }
  input { padding: 0.4rem 0.6rem; font-size: 0.9rem; width: 100%; box-sizing: border-box; margin: 0.25rem 0 0.5rem; }
  button { cursor: pointer; padding: 0.5rem 1rem; font-size: 0.9rem; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; }
  .badge.ok { background: #e6f4ea; color: #2e7d32; }
  .badge.err { background: #fdeaea; color: #c62828; }
  .muted { color: #888; font-size: 0.85rem; }
  #msg { margin-top: 0.5rem; font-size: 0.9rem; }
</style>
</head>
<body>
  <h1>네이버 스마트스토어 연동하기</h1>
  <p class="muted">앱 등록이나 개발 지식 없이, 로그인 한 번으로 끝나요.</p>

  <div class="step">
    <h2>1. 준비물</h2>
    <p>네이버 커머스 계정과 운영 중인 스마트스토어 1개만 있으면 됩니다.</p>
  </div>

  <div class="step">
    <h2>2. 네이버 로그인 → SellerDesk 연결 허용</h2>
    ${
      consentUrl
        ? `<p>아래 버튼을 누르면 네이버 로그인 화면으로 이동합니다. 로그인 후 "SellerDesk 연결 허용"을 눌러주세요.</p>
    <a href="${consentUrl}" target="_blank" rel="noopener"><button type="button">네이버에서 연결 허용하기</button></a>`
        : `<p class="muted">이 버튼은 SellerDesk가 네이버 커머스 솔루션 제공자로 정식 등록된 후 열립니다(준비 중).
    지금은 3단계에서 네이버 계정 ID를 직접 입력해 연동을 완료할 수 있습니다.</p>`
    }
  </div>

  <div class="step">
    <h2>3~4. 계정 확인 및 저장</h2>
    <p>네이버에서 허용을 마치면 이 화면으로 돌아옵니다. 계정 ID가 자동으로 채워지지 않으면 아래에 직접 입력해주세요.</p>
    <label for="tenantId">셀러 ID</label>
    <input id="tenantId" placeholder="예: seller-123" />
    <label for="accountId">네이버 계정 ID (account_id)</label>
    <input id="accountId" placeholder="네이버 커머스 계정 ID" />
    <button id="connect" type="button">연동하기</button>
    <div id="msg"></div>
  </div>

  <div class="step" id="step5">
    <h2>5. 연동 확인 & 첫 동기화</h2>
    <p class="muted">저장에 성공하면 자동으로 계정 유효성을 확인하고 최근 주문/상품을 가져오기 시작합니다.</p>
  </div>

  <script>
    const params = new URLSearchParams(location.search);
    const accountIdInput = document.querySelector("#accountId");
    const tenantIdInput = document.querySelector("#tenantId");
    if (params.get("accountId")) accountIdInput.value = params.get("accountId");
    if (params.get("tenantId")) tenantIdInput.value = params.get("tenantId");

    document.querySelector("#connect").addEventListener("click", async () => {
      const msg = document.querySelector("#msg");
      const tenantId = tenantIdInput.value.trim();
      const accountId = accountIdInput.value.trim();
      if (!tenantId || !accountId) {
        msg.innerHTML = '<span class="badge err">셀러 ID와 계정 ID를 모두 입력해주세요</span>';
        return;
      }
      msg.textContent = "연동 확인 중…";
      try {
        const res = await fetch("/api/connections/naver/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantId, accountId }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.innerHTML = '<span class="badge err">연동 실패</span> ' + (data.error ?? "");
          return;
        }
        msg.innerHTML = '<span class="badge ok">연동 완료</span>';
        await fetch("/api/sync/run", { method: "POST" });
        document.querySelector("#step5").classList.add("done");
      } catch (err) {
        msg.innerHTML = '<span class="badge err">연동 실패</span> ' + err;
      }
    });
  </script>
</body>
</html>`;
}
