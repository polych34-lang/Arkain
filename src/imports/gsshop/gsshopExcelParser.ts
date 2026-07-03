import ExcelJS from "exceljs";
import type { NormalizedOrder } from "../../integrations/marketplace.js";
import {
  GsShopFormatError,
  GsShopRow,
  HEADER_ALIASES,
  REQUIRED_FIELDS,
  type GsShopRowError,
  type GsShopRowT,
} from "./gsshop.types.js";
import { mapGsShopRowsToOrders } from "./gsshop.mapper.js";

/**
 * I/O boundary: GS샵 파트너스 "주문리스트" 엑셀(.xlsx) 버퍼 -> `NormalizedOrder[]`.
 * "별도 임포트 컴포넌트, 어댑터 아님" (ARK-15 §3(a)) — `MarketplaceAdapter`를
 * 구현하지 않는다. 대신 마지막에 기존 `PrismaDomainStore.upsertOrders`로 바로
 * 넘길 수 있는 `NormalizedOrder[]`를 만들어, 오픈마켓 어댑터와 같은 저장 경로를
 * 공유한다(중복 스토리지 계층 없음).
 *
 * 헤더는 첫 워크시트의 1행으로 가정한다 — 포털 다운로드 파일의 통상 관행이며,
 * 실 샘플로는 아직 검증되지 않았다(docs/gsshop-excel-import.md 블로커 참고).
 */

export interface GsShopImportResult {
  orders: NormalizedOrder[];
  /** 파싱/검증에 실패해 건너뛴 행 — 한 행이 잘못됐다고 배치 전체를 막지 않는다. */
  rowErrors: GsShopRowError[];
  /** 헤더 행을 제외하고 실제로 읽은 데이터 행 수. */
  rowsRead: number;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveHeaderColumns(
  headerRow: ExcelJS.Row,
): Partial<Record<keyof GsShopRowT, number>> {
  const colByHeaderText = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    colByHeaderText.set(normalizeHeader(cell.value), colNumber);
  });

  const resolved: Partial<Record<keyof GsShopRowT, number>> = {};
  for (const field of Object.keys(HEADER_ALIASES) as (keyof GsShopRowT)[]) {
    for (const alias of HEADER_ALIASES[field]) {
      const col = colByHeaderText.get(alias);
      if (col != null) {
        resolved[field] = col;
        break;
      }
    }
  }
  return resolved;
}

/** exceljs cell value를 문자열로 정규화. 날짜 셀은 ISO로, rich-text/hyperlink
 * 셀은 표시 텍스트로 풀어낸다. 빈 셀은 null(값 자체가 없었다는 것을 zod 단계까지
 * 보존해 "빈 값" 에러 메시지가 나오게 한다). */
function cellText(row: ExcelJS.Row, col: number | undefined): string | null {
  if (col == null) return null;
  const value: unknown = row.getCell(col).value;
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const obj = value as { text?: unknown; result?: unknown };
    if ("text" in obj) return String(obj.text ?? ""); // rich-text/hyperlink 셀
    if ("result" in obj) return String(obj.result ?? ""); // 수식 셀 — 계산된 값
    return null;
  }
  return String(value);
}

export async function parseGsShopExcel(buffer: Buffer): Promise<GsShopImportResult> {
  const workbook = new ExcelJS.Workbook();
  // exceljs/index.d.ts declares its own ambient `Buffer extends ArrayBuffer`,
  // which conflicts with @types/node's generic `Buffer<TArrayBuffer>` —
  // a type-decl clash, not a real runtime mismatch (both are Node Buffers).
  await workbook.xlsx.load(buffer as any);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new GsShopFormatError(REQUIRED_FIELDS);
  }

  const columns = resolveHeaderColumns(worksheet.getRow(1));
  const missing = REQUIRED_FIELDS.filter((field) => columns[field] == null);
  if (missing.length > 0) {
    throw new GsShopFormatError(missing);
  }

  const rows: GsShopRowT[] = [];
  const rowErrors: GsShopRowError[] = [];
  let rowsRead = 0;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    rowsRead++;

    const raw = {
      orderNo: cellText(row, columns.orderNo),
      orderedAt: cellText(row, columns.orderedAt),
      status: cellText(row, columns.status),
      buyerName: cellText(row, columns.buyerName),
      productCode: cellText(row, columns.productCode),
      productName: cellText(row, columns.productName),
      quantity: cellText(row, columns.quantity),
      amountKrw: cellText(row, columns.amountKrw),
    };

    const parsed = GsShopRow.safeParse(raw);
    if (!parsed.success) {
      rowErrors.push({
        row: rowNumber,
        message: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
      return;
    }
    rows.push(parsed.data);
  });

  return { orders: mapGsShopRowsToOrders(rows), rowErrors, rowsRead };
}
