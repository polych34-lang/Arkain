import { renderLayout } from "./layout.js";

/**
 * ENG-Orders-MVP (ARK-5) dashboard: one table of unified orders across every
 * connected marketplace. Deliberately plain server-rendered HTML + vanilla JS
 * against `/api/orders` — ARCHITECTURE.md defers the React/Next.js UI until
 * after the order-sync MVP is proven; this is the thin interim UI that proves
 * it, not a permanent choice.
 */
export function renderOrdersDashboard(): string {
  return renderLayout({
    title: "주문관리",
    activeId: "orders",
    bodyHtml: `
      <style>
        .toolbar { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 1rem; }
        .toolbar button { padding: 0.4rem 0.9rem; }
      </style>
      <div class="toolbar">
        <button class="secondary" id="refresh">새로고침</button>
        <button class="secondary" id="sync">지금 동기화</button>
        <span id="status" class="muted"></span>
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
      <div id="empty" class="muted" hidden style="margin-top:1rem;">표시할 주문이 없습니다.</div>
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
    `,
  });
}
