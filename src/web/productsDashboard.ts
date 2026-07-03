/**
 * ARK-57 상품등록: register one product by hand + see the tenant's product
 * list. Session-gated client-side (redirects to /login on a 401 from
 * /api/products) — same posture as the rest of this interim UI layer, which
 * has no server-side page redirect middleware yet.
 */
export function renderProductsDashboard(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 상품등록</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, "Malgun Gothic", sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  nav { margin-bottom: 1rem; font-size: 0.9rem; }
  nav a { margin-right: 1rem; }
  .form-row { display: flex; gap: 0.5rem; align-items: flex-end; margin-bottom: 1rem; flex-wrap: wrap; }
  .form-row div { display: flex; flex-direction: column; }
  label { font-size: 0.8rem; color: #444; }
  input { padding: 0.4rem 0.6rem; font-size: 0.9rem; }
  button { cursor: pointer; padding: 0.4rem 0.9rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e2e2e2; font-size: 0.9rem; }
  th { color: #666; font-weight: 600; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; background: #eef; }
  .empty, .error { color: #666; margin-top: 1rem; }
  #msg { margin-top: 0.5rem; font-size: 0.9rem; }
  .badge.err { background: #fdeaea; color: #c62828; }
</style>
</head>
<body>
  <nav>
    <a href="/products">상품등록</a>
    <a href="/orders">주문확인</a>
    <a href="/connections">연동관리</a>
    <a href="#" id="logout">로그아웃</a>
  </nav>
  <h1>상품등록</h1>
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

  <table id="products">
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
  <div id="empty" class="empty" hidden>등록된 상품이 없습니다.</div>

  <script>
    const tbody = document.querySelector("#products tbody");
    const empty = document.querySelector("#empty");
    const msg = document.querySelector("#msg");

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

    document.querySelector("#logout").addEventListener("click", async (e) => {
      e.preventDefault();
      await fetch("/api/auth/logout", { method: "POST" });
      location.href = "/login";
    });

    load();
  </script>
</body>
</html>`;
}
