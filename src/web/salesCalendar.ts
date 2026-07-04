import { renderLayout } from "./layout.js";

/**
 * ARK-77: 매출/정산 캘린더 그리드 셸 (spec: ARK-14, data wiring: ARK-17).
 * UI 뼈대만 — 월간 그리드, 월 이동, 로딩/빈 상태를 갖추되 날짜별 매출/정산/
 * 예상매출 자리는 실제 데이터 없이 placeholder로 남겨둔다. ARK-17에서 이
 * placeholder 슬롯에 실제 API 데이터를 채워 넣을 예정.
 */
export function renderSalesCalendarShell(): string {
  return renderLayout({
    title: "매출/정산 캘린더",
    activeId: "sales-calendar",
    bodyHtml: `
      <style>
        .cal-toolbar { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
        .cal-toolbar h2 { font-size: 1.05rem; min-width: 8rem; text-align: center; }
        .cal-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 1px;
          background: var(--border);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          overflow: hidden;
        }
        .cal-weekday {
          background: var(--bg);
          color: var(--ink-muted);
          font-size: 0.78rem;
          font-weight: 600;
          text-align: center;
          padding: 0.5rem 0;
        }
        .cal-cell { background: var(--surface); min-height: 92px; padding: 0.4rem 0.5rem; }
        .cal-cell.outside { background: var(--bg); }
        .cal-date { font-size: 0.85rem; font-weight: 600; }
        .cal-slot { font-size: 0.72rem; color: var(--ink-muted); margin-top: 0.3rem; }
        .cal-loading, .cal-empty { text-align: center; padding: 2.5rem 1rem; color: var(--ink-muted); }
      </style>
      <div class="cal-toolbar">
        <button class="secondary" id="prevMonth">‹ 이전달</button>
        <h2 id="monthLabel"></h2>
        <button class="secondary" id="nextMonth">다음달 ›</button>
      </div>
      <div id="calBody"></div>

      <script>
        const monthLabel = document.querySelector("#monthLabel");
        const calBody = document.querySelector("#calBody");
        const weekdayLabels = ["일", "월", "화", "수", "목", "금", "토"];
        const cursor = new Date();
        cursor.setDate(1);

        function renderGrid() {
          const year = cursor.getFullYear();
          const month = cursor.getMonth();
          const firstDay = new Date(year, month, 1).getDay();
          const daysInMonth = new Date(year, month + 1, 0).getDate();

          let cellsHtml = weekdayLabels.map((w) => \`<div class="cal-weekday">\${w}</div>\`).join("");
          for (let i = 0; i < firstDay; i++) {
            cellsHtml += '<div class="cal-cell outside"></div>';
          }
          for (let d = 1; d <= daysInMonth; d++) {
            cellsHtml += \`
              <div class="cal-cell">
                <div class="cal-date">\${d}</div>
                <div class="cal-slot">매출 -</div>
                <div class="cal-slot">정산 -</div>
                <div class="cal-slot">예상매출 -</div>
              </div>
            \`;
          }
          const totalCells = firstDay + daysInMonth;
          const trailing = (7 - (totalCells % 7)) % 7;
          for (let i = 0; i < trailing; i++) {
            cellsHtml += '<div class="cal-cell outside"></div>';
          }

          calBody.innerHTML = \`
            <div class="cal-grid">\${cellsHtml}</div>
            <div class="cal-empty">이 달의 정산 데이터가 없습니다. 데이터 연동 준비 중입니다.</div>
          \`;
        }

        function load() {
          monthLabel.textContent = \`\${cursor.getFullYear()}년 \${cursor.getMonth() + 1}월\`;
          calBody.innerHTML = '<div class="cal-loading">불러오는 중…</div>';
          setTimeout(renderGrid, 200);
        }

        document.querySelector("#prevMonth").addEventListener("click", () => {
          cursor.setMonth(cursor.getMonth() - 1);
          load();
        });
        document.querySelector("#nextMonth").addEventListener("click", () => {
          cursor.setMonth(cursor.getMonth() + 1);
          load();
        });

        load();
      </script>
    `,
  });
}
