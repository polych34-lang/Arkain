import { renderLayout } from "./layout.js";

/**
 * ARK-72: nav slot for the 매출/정산 캘린더 differentiator (spec: ARK-14,
 * implementation: ARK-17, currently reassigned to the Founding Engineer and
 * blocked on ARK-22). This is a placeholder so the sidebar item is honest —
 * clickable, but upfront about not being wired to real data yet — rather
 * than a dead link or a fabricated dashboard.
 */
export function renderSalesCalendarPlaceholder(): string {
  return renderLayout({
    title: "매출/정산 캘린더",
    activeId: "sales-calendar",
    bodyHtml: `
      <div class="card">
        <h2>매출/정산 캘린더 뷰 — 준비 중</h2>
        <p class="muted" style="margin-top:0.75rem;">
          달력 형태로 예상매출·정산·입금을 한눈에 보는 화면입니다 (스펙: ARK-14).
          구현(ARK-17)이 완료되면 이 화면에 실제 데이터가 연결됩니다.
        </p>
      </div>
    `,
  });
}
