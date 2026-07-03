/**
 * ENG-Orders-MVP (ARK-5) dashboard: one table of unified orders across every
 * connected marketplace. Deliberately plain server-rendered HTML + vanilla JS
 * against `/api/orders` — ARCHITECTURE.md defers the React/Next.js UI until
 * after the order-sync MVP is proven; this is the thin interim UI that proves
 * it, not a permanent choice.
 */
export function renderOrdersDashboard(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 주문관리</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, "Malgun Gothic", sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e2e2e2; font-size: 0.9rem; }
  th { color: #666; font-weight: 600; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; background: #eef; }
  .empty, .error { color: #666; margin-top: 1rem; }
  .toolbar { display: flex; gap: 0.5rem; align-items: center; }
  button { cursor: pointer; padding: 0.35rem 0.75rem; }
  nav { margin-bottom: 1rem; font-size: 0.9rem; }
  nav a { margin-right: 1rem; }
</style>
</head>
<body>
  <nav>
    <a href="/products">상품등록</a>
    <a href="/orders">주문확인</a>
    <a href="/connections">연동관리</a>
  </nav>
  <div class="toolbar">
    <h1>주문관리 — 통합 주문 대시보드</h1>
    <button id="refresh">새로고침</button>
    <button id="sync">지금 동기화</button>
    <span id="status"></span>
  </div>
  <table id="orders">
    <thead>
      <tr>
        <th>마켓</th>
        <th>주문번호</th>
        <th>상태</th>
        <th>구매자</th>
        <th>품목수</th>
        <th>금액(원)</th>
        <th>주문일시</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
  <div id="empty" class="empty" hidden>표시할 주문이 없습니다.</div>
  <script>
    const tbody = document.querySelector("#orders tbody");
    const empty = document.querySelector("#empty");
    const status = document.querySelector("#status");

    async function load() {
      status.textContent = "불러오는 중…";
      try {
        const res = await fetch("/api/orders?limit=100");
        if (res.status === 401) {
          location.href = "/login";
          return;
        }
        const data = await res.json();
        tbody.innerHTML = "";
        if (!data.configured) {
          status.textContent = "DB 미설정 (DATABASE_URL)";
          empty.hidden = false;
          return;
        }
        empty.hidden = data.orders.length > 0;
        for (const o of data.orders) {
          const tr = document.createElement("tr");
          tr.innerHTML = \`
            <td>\${o.marketplace}</td>
            <td>\${o.marketplaceOrderId}</td>
            <td><span class="badge">\${o.status}</span></td>
            <td>\${o.buyerName ?? "-"}</td>
            <td>\${o.itemCount}</td>
            <td>\${o.totalAmountKrw.toLocaleString("ko-KR")}</td>
            <td>\${new Date(o.orderedAt).toLocaleString("ko-KR")}</td>
          \`;
          tbody.appendChild(tr);
        }
        status.textContent = \`주문 \${data.orders.length}건\`;
      } catch (err) {
        status.textContent = "불러오기 실패: " + err;
      }
    }

    document.querySelector("#refresh").addEventListener("click", load);
    document.querySelector("#sync").addEventListener("click", async () => {
      status.textContent = "동기화 중…";
      try {
        const res = await fetch("/api/sync/run", { method: "POST" });
        if (!res.ok) {
          const body = await res.json();
          status.textContent = "동기화 불가: " + body.error;
          return;
        }
        await load();
      } catch (err) {
        status.textContent = "동기화 실패: " + err;
      }
    });

    load();
  </script>
</body>
</html>`;
}
