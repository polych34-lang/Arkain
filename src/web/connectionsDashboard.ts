import { renderLayout } from "./layout.js";

/**
 * ARK-21: 연동 상태/재연동 관리 화면. Reads `/api/connections`, same interim
 * posture as `ordersDashboard.ts` (ARK-5) — that API still takes an explicit
 * `tenantId` query param (no session enforcement there yet, ARK-21's
 * original scope). ARK-72: the tenantId is now taken from the logged-in
 * session (`/api/auth/me`) instead of a raw text box, so the seller never
 * has to know their own internal id to use the screen.
 *
 * ARK-74: 재연동 버튼은 마켓별 온보딩 위저드로 링크한다(이전엔 모든 마켓이
 * 네이버 위저드로 고정 링크됐었음). 위저드가 없는 마켓은 연동 현황 화면
 * 자체로 링크해 죽은 경로를 만들지 않는다.
 */
const ONBOARDING_HREF_BY_MARKETPLACE: Record<string, string> = {
  naver_smartstore: "/onboarding/naver",
  coupang: "/onboarding/coupang",
};

export function renderConnectionsDashboard(): string {
  return renderLayout({
    title: "연동 현황",
    activeId: "connections",
    bodyHtml: `
      <div class="toolbar" style="margin-bottom:1rem;">
        <span id="status" class="muted"></span>
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
      <div id="empty" class="muted" hidden style="margin-top:1rem;">연동된 마켓이 없습니다.</div>
      <script>
        const onboardingHrefByMarketplace = ${JSON.stringify(ONBOARDING_HREF_BY_MARKETPLACE)};
        const tbody = document.querySelector("#connections tbody");
        const empty = document.querySelector("#empty");
        const status = document.querySelector("#status");

        async function load() {
          const me = await (await fetch("/api/auth/me")).json();
          if (!me.authenticated) {
            location.href = "/login";
            return;
          }
          const tenantId = me.sellerId;
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
              const onboardingHref = onboardingHrefByMarketplace[c.marketplace];
              const reconnectCell = onboardingHref
                ? \`<a class="button secondary" href="\${onboardingHref}">재연동</a>\`
                : "";
              tr.innerHTML = \`
                <td>\${c.marketplace}</td>
                <td><span class="badge \${badgeClass}">\${c.status}</span></td>
                <td>\${new Date(c.createdAt).toLocaleString("ko-KR")}</td>
                <td>\${lastSync}</td>
                <td>\${reconnectCell}</td>
              \`;
              tbody.appendChild(tr);
            }
            status.textContent = \`연동 \${data.connections.length}건\`;
          } catch (err) {
            status.textContent = "불러오기 실패: " + err;
          }
        }

        load();
      </script>
    `,
  });
}
