import { renderLayout } from "./layout.js";

/**
 * ARK-46: GS샵 주문리스트 엑셀 업로드 화면. `ordersDashboard.ts`/
 * `connectionsDashboard.ts`(ARK-5/21)와 같은 인터림 톤 — 서버렌더 HTML +
 * vanilla JS. ARK-72: 셀러 ID는 이제 로그인 세션(`/api/auth/me`)에서 가져온다.
 */
export function renderGsShopImport(): string {
  return renderLayout({
    title: "GS샵 주문 임포트",
    activeId: "gsshop-import",
    bodyHtml: `
      <p class="muted">GS샵 파트너스 포털에서 내려받은 "주문리스트" 엑셀(.xlsx)을 업로드하세요.</p>
      <div class="toolbar" style="display:flex;gap:0.75rem;align-items:center;margin-top:1rem;">
        <input id="file" type="file" accept=".xlsx" style="width:auto;" />
        <button id="upload" type="button">업로드</button>
      </div>
      <div id="status" class="muted" style="margin-top:0.75rem;"></div>
      <div id="summary" style="margin-top:1rem;"></div>
      <script>
        const fileInput = document.querySelector("#file");
        const status = document.querySelector("#status");
        const summary = document.querySelector("#summary");

        document.querySelector("#upload").addEventListener("click", async () => {
          const me = await (await fetch("/api/auth/me")).json();
          if (!me.authenticated) {
            location.href = "/login";
            return;
          }
          const file = fileInput.files[0];
          summary.innerHTML = "";
          if (!file) {
            status.textContent = "엑셀 파일을 선택해주세요";
            return;
          }
          status.textContent = "업로드 중…";
          try {
            const form = new FormData();
            form.append("tenantId", me.sellerId);
            form.append("file", file);
            const res = await fetch("/api/imports/gsshop", { method: "POST", body: form });
            const data = await res.json();
            if (!res.ok) {
              status.textContent = "임포트 실패: " + data.error;
              return;
            }
            status.textContent = \`임포트 완료 — 주문 \${data.ordersImported}건 (누적 \${data.totalOrders}건)\`;
            if (data.rowErrors.length > 0) {
              const list = data.rowErrors
                .map((e) => \`<li>\${e.row}행: \${e.message}</li>\`)
                .join("");
              summary.innerHTML = \`<div class="badge err" style="display:block;padding:0.6rem;"><strong>건너뛴 행 \${data.rowErrors.length}건</strong><ul>\${list}</ul></div>\`;
            }
          } catch (err) {
            status.textContent = "업로드 실패: " + err;
          }
        });
      </script>
    `,
  });
}
