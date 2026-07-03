/**
 * ARK-46: GS샵 주문리스트 엑셀 업로드 화면. `ordersDashboard.ts`/
 * `connectionsDashboard.ts`(ARK-5/21)와 같은 인터림 톤 — 서버렌더 HTML +
 * vanilla JS, 세션/인증 레이어가 없어 셀러 ID를 직접 입력받는다.
 */
export function renderGsShopImport(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — GS샵 주문 엑셀 임포트</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, "Malgun Gothic", sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  p.hint { color: #666; font-size: 0.85rem; }
  .toolbar { display: flex; gap: 0.5rem; align-items: center; margin-top: 1rem; }
  input { padding: 0.35rem 0.6rem; }
  button { cursor: pointer; padding: 0.35rem 0.75rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e2e2e2; font-size: 0.9rem; }
  th { color: #666; font-weight: 600; }
  .error-list { color: #c62828; font-size: 0.85rem; margin-top: 1rem; }
  .summary { margin-top: 1rem; }
</style>
</head>
<body>
  <h1>GS샵 주문 엑셀 임포트</h1>
  <p class="hint">GS샵 파트너스 포털에서 내려받은 "주문리스트" 엑셀(.xlsx)을 업로드하세요.</p>
  <div class="toolbar">
    <input id="tenantId" placeholder="셀러 ID" />
    <input id="file" type="file" accept=".xlsx" />
    <button id="upload" type="button">업로드</button>
  </div>
  <div id="status"></div>
  <div id="summary" class="summary"></div>
  <script>
    const tenantIdInput = document.querySelector("#tenantId");
    const fileInput = document.querySelector("#file");
    const status = document.querySelector("#status");
    const summary = document.querySelector("#summary");

    const params = new URLSearchParams(location.search);
    if (params.get("tenantId")) tenantIdInput.value = params.get("tenantId");

    document.querySelector("#upload").addEventListener("click", async () => {
      const tenantId = tenantIdInput.value.trim();
      const file = fileInput.files[0];
      summary.innerHTML = "";
      if (!tenantId) {
        status.textContent = "셀러 ID를 입력해주세요";
        return;
      }
      if (!file) {
        status.textContent = "엑셀 파일을 선택해주세요";
        return;
      }
      status.textContent = "업로드 중…";
      try {
        const form = new FormData();
        form.append("tenantId", tenantId);
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
          summary.innerHTML = \`<div class="error-list"><strong>건너뛴 행 \${data.rowErrors.length}건</strong><ul>\${list}</ul></div>\`;
        }
      } catch (err) {
        status.textContent = "업로드 실패: " + err;
      }
    });
  </script>
</body>
</html>`;
}
