import { renderLayout } from "./layout.js";
import { renderOnboardingChecklist } from "./onboardingChecklist.js";

/**
 * ARK-57 상품등록: register one product by hand + see the tenant's product
 * list. Session-gated client-side (redirects to /login on a 401 from
 * /api/products) — same posture as the rest of this interim UI layer, which
 * has no server-side page redirect middleware yet.
 */
export function renderProductsDashboard(): string {
  return renderLayout({
    title: "상품등록",
    activeId: "products",
    bodyHtml: `
      <style>
        .form-row { display: flex; gap: 0.75rem; align-items: flex-end; margin-bottom: 1rem; flex-wrap: wrap; }
        .form-row div { display: flex; flex-direction: column; }
        .form-row label { margin-top: 0; }
        .form-row input { margin: 0.25rem 0 0; }
      </style>
      ${renderOnboardingChecklist()}
      <div class="card">
        <div class="form-row">
          <div>
            <label for="name">상품명</label>
            <input id="name" placeholder="예: 유기농 현미 2kg" />
          </div>
          <div>
            <label for="price">판매가(원)</label>
            <input id="price" type="number" min="0" placeholder="19000" />
          </div>
          <div>
            <label for="stock">재고수량</label>
            <input id="stock" type="number" min="0" placeholder="100" />
          </div>
          <button id="register" type="button">상품 등록</button>
        </div>
        <div id="msg"></div>
      </div>

      <table id="products" style="margin-top:1.25rem;">
        <thead>
          <tr>
            <th>상품명</th>
            <th>판매가(원)</th>
            <th>재고</th>
            <th>상태</th>
            <th>등록일시</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
      <div id="empty" hidden style="margin-top:1.5rem;text-align:center;padding:2rem 1rem;">
        <p class="muted">등록된 상품이 없습니다. 첫 상품을 등록해보세요.</p>
        <button type="button" id="emptyCta">상품 등록하러 가기</button>
      </div>

      <script>
        const tbody = document.querySelector("#products tbody");
        const empty = document.querySelector("#empty");
        const msg = document.querySelector("#msg");

        document.querySelector("#emptyCta").addEventListener("click", () => {
          document.querySelector("#name").scrollIntoView({ behavior: "smooth", block: "center" });
          document.querySelector("#name").focus();
        });

        async function load() {
          const res = await fetch("/api/products");
          if (res.status === 401) {
            location.href = "/login";
            return;
          }
          const data = await res.json();
          tbody.innerHTML = "";
          if (!data.configured) {
            msg.textContent = "DB 미설정 (DATABASE_URL)";
            empty.hidden = false;
            return;
          }
          empty.hidden = data.products.length > 0;
          for (const p of data.products) {
            const tr = document.createElement("tr");
            tr.innerHTML = \`
              <td>\${p.name}</td>
              <td>\${p.salePriceKrw.toLocaleString("ko-KR")}</td>
              <td>\${p.stockQuantity}</td>
              <td><span class="badge">\${p.status}</span></td>
              <td>\${new Date(p.createdAt).toLocaleString("ko-KR")}</td>
            \`;
            tbody.appendChild(tr);
          }
        }

        document.querySelector("#register").addEventListener("click", async () => {
          const name = document.querySelector("#name").value.trim();
          const salePriceKrw = Number(document.querySelector("#price").value);
          const stockQuantity = Number(document.querySelector("#stock").value);
          if (!name || !Number.isFinite(salePriceKrw) || !Number.isFinite(stockQuantity)) {
            msg.innerHTML = '<span class="badge err">상품명, 판매가, 재고수량을 모두 입력해주세요</span>';
            return;
          }
          msg.textContent = "등록 중…";
          try {
            const res = await fetch("/api/products", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name, salePriceKrw, stockQuantity }),
            });
            if (res.status === 401) {
              location.href = "/login";
              return;
            }
            const data = await res.json();
            if (!res.ok) {
              msg.innerHTML = '<span class="badge err">' + (data.error ?? "등록 실패") + "</span>";
              return;
            }
            msg.textContent = "";
            document.querySelector("#name").value = "";
            document.querySelector("#price").value = "";
            document.querySelector("#stock").value = "";
            await load();
          } catch (err) {
            msg.innerHTML = '<span class="badge err">등록 실패</span> ' + err;
          }
        });

        load();
      </script>
    `,
  });
}
