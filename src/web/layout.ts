/**
 * ARK-72: shared design system + app shell (sidebar nav / topbar) for every
 * post-login screen. Replaces the ad-hoc `<nav>` links + one-off inline
 * `<style>` each dashboard page (products/orders/connections/onboarding/
 * gsshop-import) used to carry on its own — same server-rendered-HTML +
 * vanilla-JS posture as those pages (ARCHITECTURE.md defers React/Next.js
 * until after the MVP), just with one shared shell instead of five copies.
 */

/** Left-nav structure, grouped the way ARKAIN OMS's sidebar groups its
 * modules (icon + collapsible group of icon+label items) — reimplemented
 * fresh here, not copied, since SellerDesk's route list is its own. Items
 * without a real screen yet still get a `badge` (e.g. "준비중") instead of
 * being left out, per the board's brief; 매출/정산 캘린더 has a grid shell
 * now (ARK-77) so it no longer carries one — data wiring is still ARK-17. */
export const NAV_GROUPS: Array<{
  label: string;
  icon: string;
  items: Array<{ id: string; label: string; href: string; icon: string; badge?: string }>;
}> = [
  {
    label: "영업",
    icon: "🧾",
    items: [
      {
        id: "products",
        label: "상품등록",
        href: "/products",
        icon: `<path d="M20.59 13.41L11 3.83A2 2 0 009.59 3.17L4 3a1 1 0 00-1 1l.17 5.59a2 2 0 00.58 1.41l9.58 9.58a2 2 0 002.83 0l4.41-4.41a2 2 0 000-2.83z"/><circle cx="7.5" cy="7.5" r="1.5"/>`,
      },
      {
        id: "orders",
        label: "주문관리",
        href: "/orders",
        icon: `<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>`,
      },
    ],
  },
  {
    label: "매출·정산",
    icon: "💰",
    items: [
      {
        id: "sales-calendar",
        label: "매출/정산 캘린더",
        href: "/sales/calendar",
        icon: `<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>`,
      },
    ],
  },
  {
    label: "마켓 연동",
    icon: "🔌",
    items: [
      {
        id: "connections",
        label: "연동 현황",
        href: "/connections",
        icon: `<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>`,
      },
      {
        id: "naver-onboarding",
        label: "네이버 스마트스토어 연동",
        href: "/onboarding/naver",
        icon: `<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>`,
      },
      {
        id: "coupang-onboarding",
        label: "쿠팡 연동",
        href: "/onboarding/coupang",
        icon: `<path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/>`,
      },
      {
        id: "gsshop-import",
        label: "GS샵 주문 임포트",
        href: "/imports/gsshop",
        icon: `<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`,
      },
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
  const groupsHtml = NAV_GROUPS.map((group, groupIndex) => {
    const groupId = `nav-group-${groupIndex}`;
    const hasActiveItem = group.items.some((item) => item.id === activeId);
    const itemsHtml = group.items
      .map((item) => {
        const active = item.id === activeId;
        const badge = item.badge ? `<span class="nav-badge">${item.badge}</span>` : "";
        return `<a class="nav-item nav-sub${active ? " active" : ""}" href="${item.href}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${item.icon}</svg><span class="nav-label">${item.label}</span>${badge}</a>`;
      })
      .join("");
    return `<div class="nav-group${hasActiveItem ? "" : " collapsed"}" id="${groupId}">
      <button type="button" class="nav-group-head" data-toggle-group="${groupId}">
        <span class="nav-group-icon">${group.icon}</span>
        <span class="nav-group-label">${group.label}</span>
        <svg class="nav-group-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="nav-group-items">${itemsHtml}</div>
    </div>`;
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
    overflow-y: auto;
  }
  .sidebar .brand { color: #fff; font-weight: 700; font-size: 1.05rem; padding: 0 0.5rem 1.25rem; }
  .nav-group { margin-bottom: 0.35rem; }
  .nav-group-head {
    width: 100%; display: flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 0.5rem; border: none; background: transparent; cursor: pointer;
    font: inherit; text-align: left;
  }
  .nav-group-icon { font-size: 0.95rem; }
  .nav-group-label { flex: 1; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7290; }
  .nav-group-arrow { width: 14px; height: 14px; color: #6b7290; transition: transform 0.15s ease; flex-shrink: 0; }
  .nav-group.collapsed .nav-group-arrow { transform: rotate(-90deg); }
  .nav-group-items { overflow: hidden; max-height: 500px; transition: max-height 0.15s ease; }
  .nav-group.collapsed .nav-group-items { max-height: 0; }
  .nav-item {
    display: flex; align-items: center; gap: 0.6rem;
    padding: 0.5rem 0.6rem; border-radius: 6px; font-size: 0.88rem;
    color: var(--sidebar-ink); text-decoration: none; margin-bottom: 0.15rem;
  }
  .nav-item svg { width: 16px; height: 16px; flex-shrink: 0; opacity: 0.8; }
  .nav-item .nav-label { flex: 1; }
  .nav-item:hover { background: rgba(255,255,255,0.06); color: #fff; }
  .nav-item.active { background: var(--brand); color: var(--sidebar-ink-active); font-weight: 600; }
  .nav-item.active svg { opacity: 1; }
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
  #navToggle, .sidebar-backdrop { display: none; }
  @media (max-width: 900px) {
    #navToggle {
      display: inline-flex; align-items: center; justify-content: center;
      width: 34px; height: 34px; padding: 0; border: 1px solid var(--border); border-radius: 6px;
      background: var(--surface); color: var(--ink); cursor: pointer; margin-right: 0.5rem;
    }
    .topbar { padding: 1rem; }
    .content { padding: 1.1rem; }
    .sidebar {
      position: fixed; top: 0; left: 0; bottom: 0; z-index: 40;
      width: 260px; max-width: 82vw;
      transform: translateX(-100%); transition: transform 0.2s ease;
    }
    .app-shell.nav-open .sidebar { transform: translateX(0); }
    .sidebar-backdrop {
      display: none; position: fixed; inset: 0; background: rgba(16,24,40,0.45); z-index: 30;
    }
    .app-shell.nav-open .sidebar-backdrop { display: block; }
  }
</style>
</head>
<body>
  <div class="app-shell" id="appShell">
    <aside class="sidebar">
      <div class="brand">ARKAIN</div>
      ${groupsHtml}
    </aside>
    <div class="sidebar-backdrop" id="navBackdrop"></div>
    <div class="main-col">
      <header class="topbar">
        <div style="display:flex;align-items:center;">
          <button type="button" id="navToggle" aria-label="메뉴 열기">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <h1>${title}</h1>
        </div>
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
      var shell = document.getElementById("appShell");
      var navToggle = document.getElementById("navToggle");
      var navBackdrop = document.getElementById("navBackdrop");
      if (navToggle && shell) {
        navToggle.addEventListener("click", function () { shell.classList.add("nav-open"); });
      }
      if (navBackdrop && shell) {
        navBackdrop.addEventListener("click", function () { shell.classList.remove("nav-open"); });
      }
      document.querySelectorAll("[data-toggle-group]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var group = document.getElementById(btn.getAttribute("data-toggle-group"));
          if (group) group.classList.toggle("collapsed");
        });
      });
    })();
  </script>
</body>
</html>`;
}
