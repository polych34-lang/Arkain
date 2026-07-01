/**
 * ARK-21: 연동 상태/재연동 관리 화면. Deliberately plain server-rendered
 * HTML + vanilla JS against `/api/connections`, same interim posture as
 * `ordersDashboard.ts` (ARK-5) — no session/auth layer yet, so the seller
 * enters their 셀러 ID explicitly (matches the rest of the pre-auth API).
 */
export function renderConnectionsDashboard(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 연동 관리</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, "Malgun Gothic", sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e2e2e2; font-size: 0.9rem; }
  th { color: #666; font-weight: 600; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; }
  .badge.active { background: #e6f4ea; color: #2e7d32; }
  .badge.other { background: #fdeaea; color: #c62828; }
  .empty, .error { color: #666; margin-top: 1rem; }
  .toolbar { display: flex; gap: 0.5rem; align-items: center; }
  input { padding: 0.35rem 0.6rem; }
  button, a.button { cursor: pointer; padding: 0.35rem 0.75rem; text-decoration: none; color: inherit; border: 1px solid #ccc; border-radius: 4px; background: #fff; }
</style>
</head>
<body>
  <div class="toolbar">
    <h1>연동 관리</h1>
    <input id="tenantId" placeholder="셀러 ID" />
    <button id="load" type="button">불러오기</button>
    <span id="status"></span>
  </div>
  <table id="connections">
    <thead>
      <tr>
        <th>마켓</th>
        <th>상태</th>
        <th>연결일</th>
        <th>마지막 동기화</th>
        <th></th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
  <div id="empty" class="empty" hidden>연동된 마켓이 없습니다.</div>
  <script>
    const tbody = document.querySelector("#connections tbody");
    const empty = document.querySelector("#empty");
    const status = document.querySelector("#status");
    const tenantIdInput = document.querySelector("#tenantId");

    const params = new URLSearchParams(location.search);
    if (params.get("tenantId")) tenantIdInput.value = params.get("tenantId");

    async function load() {
      const tenantId = tenantIdInput.value.trim();
      if (!tenantId) {
        status.textContent = "셀러 ID를 입력해주세요";
        return;
      }
      status.textContent = "불러오는 중…";
      try {
        const res = await fetch("/api/connections?tenantId=" + encodeURIComponent(tenantId));
        const data = await res.json();
        tbody.innerHTML = "";
        if (!data.configured) {
          status.textContent = "DB 미설정 (DATABASE_URL)";
          empty.hidden = false;
          return;
        }
        empty.hidden = data.connections.length > 0;
        for (const c of data.connections) {
          const tr = document.createElement("tr");
          const badgeClass = c.status === "active" ? "active" : "other";
          const lastSync = c.lastSyncedAt
            ? new Date(c.lastSyncedAt).toLocaleString("ko-KR") + " (" + c.lastSyncStatus + ")"
            : "-";
          tr.innerHTML = \`
            <td>\${c.marketplace}</td>
            <td><span class="badge \${badgeClass}">\${c.status}</span></td>
            <td>\${new Date(c.createdAt).toLocaleString("ko-KR")}</td>
            <td>\${lastSync}</td>
            <td><a class="button" href="/onboarding/naver?tenantId=\${encodeURIComponent(tenantId)}">재연동</a></td>
          \`;
          tbody.appendChild(tr);
        }
        status.textContent = \`연동 \${data.connections.length}건\`;
      } catch (err) {
        status.textContent = "불러오기 실패: " + err;
      }
    }

    document.querySelector("#load").addEventListener("click", load);
  </script>
</body>
</html>`;
}
