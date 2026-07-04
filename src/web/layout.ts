/**
 * ARK-72: shared design system + app shell (sidebar nav / topbar) for every
 * post-login screen. Replaces the ad-hoc `<nav>` links + one-off inline
 * `<style>` each dashboard page (products/orders/connections/onboarding/
 * gsshop-import) used to carry on its own — same server-rendered-HTML +
 * vanilla-JS posture as those pages (ARCHITECTURE.md defers React/Next.js
 * until after the MVP), just with one shared shell instead of five copies.
 */

/** Left-nav structure, grouped the way ARKAIN OMS's sidebar groups its
 * modules (label + collapsible-looking group of items) — reimplemented
 * fresh here, not copied, since SellerDesk's route list is its own. Items
 * without a real screen yet still get a `badge` (e.g. "준비중") instead of
 * being left out, per the board's brief; 매출/정산 캘린더 has a grid shell
 * now (ARK-77) so it no longer carries one — data wiring is still ARK-17. */
export const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ id: string; label: string; href: string; badge?: string }>;
}> = [
  {
    label: "영업",
    items: [
      { id: "products", label: "상품등록", href: "/products" },
      { id: "orders", label: "주문관리", href: "/orders" },
    ],
  },
  {
    label: "매출·정산",
    items: [
      { id: "sales-calendar", label: "매출/정산 캘린더", href: "/sales/calendar" },
    ],
  },
  {
    label: "마켓 연동",
    items: [
      { id: "connections", label: "연동 현황", href: "/connections" },
      { id: "naver-onboarding", label: "네이버 스마트스토어 연동", href: "/onboarding/naver" },
      { id: "coupang-onboarding", label: "쿠팡 연동", href: "/onboarding/coupang" },
      { id: "gsshop-import", label: "GS샵 주문 임포트", href: "/imports/gsshop" },
    ],
  },
];

/** Design tokens + base resets shared by every page, including the pre-auth
 * login/signup screens (so the brand looks the same before and after
 * login). Kept as one exported string so no page hand-rolls its own palette. */
export const DESIGN_TOKENS_CSS = `
  :root {
    --brand: #2554e0;
    --brand-dark: #1a3fb0;
    --brand-soft: #eaf0ff;
    --ink: #101828;
    --ink-muted: #667085;
    --border: #e4e7ec;
    --surface: #ffffff;
    --bg: #f7f8fb;
    --sidebar-bg: #12172b;
    --sidebar-ink: #a6accb;
    --sidebar-ink-active: #ffffff;
    --success-bg: #e6f4ea;
    --success-ink: #1e7a37;
    --danger-bg: #fdeaea;
    --danger-ink: #c62828;
    --warning-bg: #fff4e5;
    --warning-ink: #b54708;
    --radius: 8px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif;
    color: var(--ink);
    background: var(--bg);
  }
  h1, h2 { margin: 0; }
  a { color: var(--brand); }
  label { display: block; font-size: 0.85rem; color: var(--ink-muted); margin-top: 0.75rem; }
  input {
    padding: 0.5rem 0.7rem;
    font-size: 0.9rem;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin: 0.3rem 0 0.5rem;
    font-family: inherit;
  }
  input:focus { outline: 2px solid var(--brand-soft); border-color: var(--brand); }
  button, a.button {
    cursor: pointer;
    padding: 0.55rem 1.1rem;
    font-size: 0.9rem;
    font-weight: 600;
    border-radius: var(--radius);
    border: 1px solid var(--brand);
    background: var(--brand);
    color: #fff;
    text-decoration: none;
    display: inline-block;
  }
  button:hover, a.button:hover { background: var(--brand-dark); border-color: var(--brand-dark); }
  button.secondary, a.button.secondary {
    background: var(--surface); color: var(--ink); border-color: var(--border);
  }
  button.secondary:hover, a.button.secondary:hover { background: var(--bg); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.6rem 0.9rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
  th { color: var(--ink-muted); font-weight: 600; background: var(--bg); }
  .badge { display: inline-block; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.75rem; background: var(--brand-soft); color: var(--brand-dark); }
  .badge.ok, .badge.active { background: var(--success-bg); color: var(--success-ink); }
  .badge.err, .badge.other { background: var(--danger-bg); color: var(--danger-ink); }
  .badge.pending { background: var(--warning-bg); color: var(--warning-ink); }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem 1.5rem;
  }
  .muted { color: var(--ink-muted); font-size: 0.85rem; }
`;

/** Full-page shell for every authenticated screen: dark sidebar (grouped
 * nav) + topbar (page title + workspace name + logout) + `<main>` content
 * area, wrapping whatever page-specific markup/script the caller supplies. */
export function renderLayout(opts: { title: string; activeId: string; bodyHtml: string }): string {
  const { title, activeId, bodyHtml } = opts;
  const groupsHtml = NAV_GROUPS.map((group) => {
    const itemsHtml = group.items
      .map((item) => {
        const active = item.id === activeId;
        const badge = item.badge ? `<span class="nav-badge">${item.badge}</span>` : "";
        return `<a class="nav-item${active ? " active" : ""}" href="${item.href}">${item.label}${badge}</a>`;
      })
      .join("");
    return `<div class="nav-group"><div class="nav-group-label">${group.label}</div>${itemsHtml}</div>`;
  }).join("");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — ${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${DESIGN_TOKENS_CSS}
  .app-shell { display: flex; min-height: 100vh; }
  .sidebar {
    width: 232px;
    flex-shrink: 0;
    background: var(--sidebar-bg);
    color: var(--sidebar-ink);
    padding: 1.25rem 0.9rem;
  }
  .sidebar .brand { color: #fff; font-weight: 700; font-size: 1.05rem; padding: 0 0.5rem 1.25rem; }
  .nav-group { margin-bottom: 1.25rem; }
  .nav-group-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7290; padding: 0 0.5rem 0.4rem; }
  .nav-item {
    display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
    padding: 0.5rem 0.6rem; border-radius: 6px; font-size: 0.88rem;
    color: var(--sidebar-ink); text-decoration: none; margin-bottom: 0.15rem;
  }
  .nav-item:hover { background: rgba(255,255,255,0.06); color: #fff; }
  .nav-item.active { background: var(--brand); color: var(--sidebar-ink-active); font-weight: 600; }
  .nav-badge { font-size: 0.65rem; background: rgba(255,255,255,0.12); color: #d0d4e8; padding: 0.05rem 0.4rem; border-radius: 999px; }
  .main-col { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1rem 1.75rem; background: var(--surface); border-bottom: 1px solid var(--border);
  }
  .topbar h1 { font-size: 1.1rem; }
  .topbar-right { display: flex; align-items: center; gap: 0.9rem; font-size: 0.85rem; color: var(--ink-muted); }
  #workspaceName { font-weight: 600; color: var(--ink); }
  #logout { cursor: pointer; }
  .content { padding: 1.75rem; flex: 1; }
</style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">ARKAIN</div>
      ${groupsHtml}
    </aside>
    <div class="main-col">
      <header class="topbar">
        <h1>${title}</h1>
        <div class="topbar-right">
          <span id="workspaceName"></span>
          <a id="logout" href="#">로그아웃</a>
        </div>
      </header>
      <main class="content">
${bodyHtml}
      </main>
    </div>
  </div>
  <script>
    (function () {
      fetch("/api/auth/me").then(function (res) { return res.json(); }).then(function (data) {
        if (!data.authenticated) { location.href = "/login"; return; }
        var el = document.getElementById("workspaceName");
        if (el && data.displayName) el.textContent = data.displayName;
      });
      var logout = document.getElementById("logout");
      if (logout) {
        logout.addEventListener("click", function (e) {
          e.preventDefault();
          fetch("/api/auth/logout", { method: "POST" }).then(function () { location.href = "/login"; });
        });
      }
    })();
  </script>
</body>
</html>`;
}
