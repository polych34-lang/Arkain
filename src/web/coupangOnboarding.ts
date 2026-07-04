import { renderLayout } from "./layout.js";

/**
 * ARK-74: 쿠팡 셀프서비스 온보딩 — 네이버 위저드(`naverOnboarding.ts`, ARK-21)와
 * 동일한 5스텝 골격을 재사용하되, 2단계 내용은 쿠팡의 실제 연동 방식에 맞게
 * 바꿨다: 쿠팡은 네이버 SELLER 모드처럼 "로그인 → 연결 허용" OAuth 동의 화면이
 * 없고, 셀러가 WING 파트너센터에서 직접 발급한 Vendor ID/Access Key/Secret Key
 * 세 값을 입력하는 방식이다(docs/coupang-integration.md §2). 그래서 이 화면엔
 * `consentUrl` 분기가 없다 — 처음부터 3필드 입력 폼만 있으면 된다.
 */
export function renderCoupangOnboarding(): string {
  return renderLayout({
    title: "쿠팡 연동",
    activeId: "coupang-onboarding",
    bodyHtml: `
      <style>
        .step { border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; background: var(--surface); }
        .step h2 { font-size: 1rem; margin: 0 0 0.5rem; }
        .step p { color: var(--ink-muted); font-size: 0.9rem; line-height: 1.5; }
        .step.done { border-color: var(--success-ink); background: var(--success-bg); }
      </style>
      <p class="muted">쿠팡 WING에서 발급받은 API 키 3가지만 있으면 연동할 수 있어요.</p>

      <div class="step">
        <h2>1. 준비물</h2>
        <p>쿠팡 WING 파트너센터에서 발급한 <strong>Vendor ID</strong>, <strong>Access Key</strong>, <strong>Secret Key</strong>가 필요합니다.</p>
      </div>

      <div class="step">
        <h2>2. 쿠팡 WING에서 API 키 발급</h2>
        <p>WING 로그인 &gt; 오픈API 관리 메뉴에서 Access Key/Secret Key를 발급받고, 함께 표시되는 Vendor ID를 확인해주세요.
        (쿠팡은 네이버와 달리 별도 연결 허용 화면이 없어, 발급받은 키를 아래에 직접 입력하면 됩니다.)</p>
      </div>

      <div class="step">
        <h2>3~4. 키 입력 및 저장</h2>
        <label for="vendorId">Vendor ID</label>
        <input id="vendorId" placeholder="쿠팡 Vendor ID" />
        <label for="accessKey">Access Key</label>
        <input id="accessKey" placeholder="쿠팡 Access Key" />
        <label for="secretKey">Secret Key</label>
        <input id="secretKey" type="password" placeholder="쿠팡 Secret Key" />
        <button id="connect" type="button">연동하기</button>
        <div id="msg"></div>
      </div>

      <div class="step" id="step5">
        <h2>5. 연동 확인 & 첫 동기화</h2>
        <p class="muted">저장에 성공하면 자동으로 키 유효성을 확인하고 최근 주문/상품을 가져오기 시작합니다.</p>
      </div>

      <script>
        const vendorIdInput = document.querySelector("#vendorId");
        const accessKeyInput = document.querySelector("#accessKey");
        const secretKeyInput = document.querySelector("#secretKey");

        document.querySelector("#connect").addEventListener("click", async () => {
          const msg = document.querySelector("#msg");
          const me = await (await fetch("/api/auth/me")).json();
          if (!me.authenticated) {
            location.href = "/login";
            return;
          }
          const vendorId = vendorIdInput.value.trim();
          const accessKey = accessKeyInput.value.trim();
          const secretKey = secretKeyInput.value.trim();
          if (!vendorId || !accessKey || !secretKey) {
            msg.innerHTML = '<span class="badge err">Vendor ID/Access Key/Secret Key를 모두 입력해주세요</span>';
            return;
          }
          msg.textContent = "연동 확인 중…";
          try {
            const res = await fetch("/api/connections/coupang/connect", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tenantId: me.sellerId, vendorId, accessKey, secretKey }),
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
    `,
  });
}
