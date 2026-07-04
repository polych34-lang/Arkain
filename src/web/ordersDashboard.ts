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
        .toolbar button, .toolbar select { padding: 0.4rem 0.9rem; }
        #orders tbody tr { cursor: pointer; }
        #orders tbody tr:hover { background: var(--brand-soft); }
        #detail { margin-top: 1rem; }
        #detail .detail-actions { display: flex; gap: 0.6rem; align-items: center; margin-top: 0.75rem; }
        #detail ul { margin: 0.5rem 0 0; padding-left: 1.2rem; }
      </style>
      <div class="toolbar">
        <button class="secondary" id="refresh">새로고침</button>
        <button class="secondary" id="sync">지금 동기화</button>
        <select id="statusFilter">
          <option value="">전체 상태</option>
          <option value="PENDING">PENDING</option>
          <option value="PAID">PAID</option>
          <option value="DISPATCHED">DISPATCHED</option>
          <option value="DELIVERED">DELIVERED</option>
          <option value="CONFIRMED">CONFIRMED</option>
          <option value="CANCELLED">CANCELLED</option>
          <option value="RETURNED">RETURNED</option>
          <option value="EXCHANGED">EXCHANGED</option>
          <option value="MIXED">MIXED</option>
          <option value="UNKNOWN">UNKNOWN</option>
        </select>
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

      <div id="detail" class="card" hidden>
        <div class="detail-actions">
          <strong>주문 상세</strong>
          <button class="secondary" id="closeDetail" style="margin-left:auto;">닫기</button>
        </div>
        <div id="detailBody"></div>
        <div class="detail-actions">
          <select id="statusSelect">
            <option value="PENDING">PENDING</option>
            <option value="PAID">PAID</option>
            <option value="DISPATCHED">DISPATCHED</option>
            <option value="DELIVERED">DELIVERED</option>
            <option value="CONFIRMED">CONFIRMED</option>
            <option value="CANCELLED">CANCELLED</option>
            <option value="RETURNED">RETURNED</option>
            <option value="EXCHANGED">EXCHANGED</option>
            <option value="MIXED">MIXED</option>
            <option value="UNKNOWN">UNKNOWN</option>
          </select>
          <button id="saveStatus">상태 저장</button>
          <span id="detailStatus" class="muted"></span>
        </div>
      </div>

      <script>
        const tbody = document.querySelector("#orders tbody");
        const empty = document.querySelector("#empty");
        const status = document.querySelector("#status");
        const statusFilter = document.querySelector("#statusFilter");
        const detail = document.querySelector("#detail");
        const detailBody = document.querySelector("#detailBody");
        const detailStatus = document.querySelector("#detailStatus");
        const statusSelect = document.querySelector("#statusSelect");

        function ordersUrl() {
          const params = new URLSearchParams({ limit: "100" });
          if (statusFilter.value) params.set("status", statusFilter.value);
          return \`/api/orders?\${params.toString()}\`;
        }

        async function load() {
          status.textContent = "불러오는 중…";
          try {
            const res = await fetch(ordersUrl());
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
              tr.addEventListener("click", () => openDetail(o.id));
              tbody.appendChild(tr);
            }
            status.textContent = \`주문 \${data.orders.length}건\`;
          } catch (err) {
            status.textContent = "불러오기 실패: " + err;
          }
        }

        function renderDetail(order) {
          detailBody.innerHTML = \`
            <p><strong>마켓</strong> \${order.marketplace} · <strong>주문번호</strong> \${order.marketplaceOrderId}</p>
            <p><strong>구매자</strong> \${order.buyerName ?? "-"} · <strong>주문일시</strong> \${new Date(order.orderedAt).toLocaleString("ko-KR")}</p>
            <p><strong>금액</strong> \${order.totalAmountKrw.toLocaleString("ko-KR")}원</p>
            <ul>
              \${order.items.map((i) => \`<li>\${i.productName} × \${i.quantity} (\${i.unitPriceKrw.toLocaleString("ko-KR")}원)</li>\`).join("")}
            </ul>
          \`;
          statusSelect.value = order.status;
          detail.dataset.id = order.id;
        }

        async function openDetail(id) {
          detail.hidden = false;
          detailStatus.textContent = "불러오는 중…";
          try {
            const res = await fetch(\`/api/orders/\${id}\`);
            if (res.status === 401) {
              location.href = "/login";
              return;
            }
            if (!res.ok) {
              const body = await res.json();
              detailStatus.textContent = "불러오기 실패: " + (body.error ?? res.status);
              return;
            }
            const { order } = await res.json();
            renderDetail(order);
            detailStatus.textContent = "";
          } catch (err) {
            detailStatus.textContent = "불러오기 실패: " + err;
          }
        }

        document.querySelector("#closeDetail").addEventListener("click", () => {
          detail.hidden = true;
        });

        document.querySelector("#saveStatus").addEventListener("click", async () => {
          const id = detail.dataset.id;
          detailStatus.textContent = "저장 중…";
          try {
            const res = await fetch(\`/api/orders/\${id}\`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: statusSelect.value }),
            });
            if (!res.ok) {
              const body = await res.json();
              detailStatus.textContent = "저장 실패: " + body.error;
              return;
            }
            const { order } = await res.json();
            renderDetail(order);
            detailStatus.textContent = "저장됨";
            await load();
          } catch (err) {
            detailStatus.textContent = "저장 실패: " + err;
          }
        });

        statusFilter.addEventListener("change", load);
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
