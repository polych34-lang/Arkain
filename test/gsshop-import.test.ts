import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildApp, type GsShopImportDeps } from "../src/app.js";
import type { NormalizedOrder } from "../src/integrations/marketplace.js";
import { mapGsShopRowsToOrders } from "../src/imports/gsshop/gsshop.mapper.js";
import { parseGsShopExcel } from "../src/imports/gsshop/gsshopExcelParser.js";
import { GsShopFormatError, type GsShopRowT } from "../src/imports/gsshop/gsshop.types.js";

function row(overrides: Partial<GsShopRowT> = {}): GsShopRowT {
  return {
    orderNo: "GS1",
    orderedAt: "2026-07-01T00:00:00.000Z",
    status: "배송중",
    buyerName: "홍길동",
    productCode: "P1",
    productName: "상품A",
    quantity: 2,
    amountKrw: 20000,
    ...overrides,
  };
}

describe("mapGsShopRowsToOrders", () => {
  it("groups lines by orderNo into one order, summing amounts", () => {
    const orders = mapGsShopRowsToOrders([
      row({ orderNo: "GS1", productName: "A", amountKrw: 10000, quantity: 1 }),
      row({ orderNo: "GS1", productName: "B", amountKrw: 6000, quantity: 3 }),
      row({ orderNo: "GS2", productName: "C", amountKrw: 5000, quantity: 1 }),
    ]);
    expect(orders).toHaveLength(2);
    const gs1 = orders.find((o) => o.marketplaceOrderId === "GS1")!;
    expect(gs1.marketplace).toBe("gsshop");
    expect(gs1.items).toHaveLength(2);
    expect(gs1.totalAmountKrw).toBe(16000);
    expect(gs1.items[1]).toEqual({
      marketplaceProductId: "P1",
      productName: "B",
      quantity: 3,
      unitPriceKrw: 2000,
    });
  });

  it("synthesizes MIXED status when an order's lines disagree, else keeps the single status", () => {
    const mixed = mapGsShopRowsToOrders([
      row({ orderNo: "GS1", status: "배송중" }),
      row({ orderNo: "GS1", status: "배송완료" }),
    ]);
    expect(mixed[0]!.status).toBe("MIXED");

    const uniform = mapGsShopRowsToOrders([
      row({ orderNo: "GS2", status: "배송중" }),
      row({ orderNo: "GS2", status: "배송중" }),
    ]);
    expect(uniform[0]!.status).toBe("배송중");
  });

  it("falls back to productName as the line-item id when productCode is absent", () => {
    const orders = mapGsShopRowsToOrders([row({ productCode: null, productName: "무옵션상품" })]);
    expect(orders[0]!.items[0]!.marketplaceProductId).toBe("무옵션상품");
  });

  it("keeps the raw lines for audit", () => {
    const lines = [row()];
    const orders = mapGsShopRowsToOrders(lines);
    expect(orders[0]!.raw).toEqual(lines);
  });
});

/** Builds a minimal .xlsx buffer with the given header row + data rows —
 * stands in for a real GS샵 파트너스 다운로드 (no real sample available yet,
 * docs/gsshop-excel-import.md). */
async function buildWorkbook(
  headers: string[],
  rows: (string | number)[][],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("주문리스트");
  sheet.addRow(headers);
  for (const r of rows) sheet.addRow(r);
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

const FULL_HEADERS = ["주문번호", "주문일시", "주문상태", "수취인명", "상품코드", "상품명", "수량", "결제금액"];

describe("parseGsShopExcel", () => {
  it("parses a well-formed workbook into normalized orders", async () => {
    const buffer = await buildWorkbook(FULL_HEADERS, [
      ["GS1", "2026-07-01 10:00", "배송중", "홍길동", "P1", "상품A", 2, 20000],
      ["GS1", "2026-07-01 10:00", "배송중", "홍길동", "P2", "상품B", 1, 5000],
      ["GS2", "2026-07-01 11:00", "구매확정", "김철수", "P3", "상품C", 1, "12,000"],
    ]);

    const result = await parseGsShopExcel(buffer);
    expect(result.rowErrors).toEqual([]);
    expect(result.rowsRead).toBe(3);
    expect(result.orders).toHaveLength(2);

    const gs1 = result.orders.find((o) => o.marketplaceOrderId === "GS1")!;
    expect(gs1.totalAmountKrw).toBe(25000);
    expect(gs1.buyerName).toBe("홍길동");
    expect(new Date(gs1.orderedAt).toISOString()).toBe(gs1.orderedAt);

    // Thousands-separator text ("12,000") parses cleanly.
    const gs2 = result.orders.find((o) => o.marketplaceOrderId === "GS2")!;
    expect(gs2.totalAmountKrw).toBe(12000);
  });

  it("matches header aliases (결제일시 instead of 주문일시)", async () => {
    const headers = ["주문번호", "결제일시", "주문상태", "수취인명", "상품코드", "상품명", "수량", "상품금액"];
    const buffer = await buildWorkbook(headers, [
      ["GS1", "2026-07-01 10:00", "배송중", "홍길동", "P1", "상품A", 1, 10000],
    ]);
    const result = await parseGsShopExcel(buffer);
    expect(result.orders).toHaveLength(1);
  });

  it("throws GsShopFormatError when required columns are missing entirely", async () => {
    const buffer = await buildWorkbook(["주문번호", "상품명"], [["GS1", "상품A"]]);
    await expect(parseGsShopExcel(buffer)).rejects.toBeInstanceOf(GsShopFormatError);
  });

  it("skips a row with a blank required cell and reports it, without dropping valid rows", async () => {
    const buffer = await buildWorkbook(FULL_HEADERS, [
      ["GS1", "2026-07-01 10:00", "배송중", "홍길동", "P1", "상품A", 2, 20000],
      ["GS2", "2026-07-01 10:00", "배송중", "홍길동", "P2", "상품B", "", 5000], // blank 수량
    ]);
    const result = await parseGsShopExcel(buffer);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]!.marketplaceOrderId).toBe("GS1");
    expect(result.rowErrors).toHaveLength(1);
    expect(result.rowErrors[0]!.row).toBe(3); // header is row 1, GS2 is row 3
  });

  it("skips a row whose amount can't be parsed as a number", async () => {
    const buffer = await buildWorkbook(FULL_HEADERS, [
      ["GS1", "2026-07-01 10:00", "배송중", "홍길동", "P1", "상품A", 1, "미확인"],
    ]);
    const result = await parseGsShopExcel(buffer);
    expect(result.orders).toEqual([]);
    expect(result.rowErrors).toHaveLength(1);
    expect(result.rowErrors[0]!.message).toContain("금액");
  });
});

describe("POST /api/imports/gsshop", () => {
  function buildMultipartBody(
    boundary: string,
    tenantId: string,
    fileBuffer: Buffer,
  ): Buffer {
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="tenantId"\r\n\r\n` +
        `${tenantId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="orders.xlsx"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    return Buffer.concat([head, fileBuffer, tail]);
  }

  function fakeStore(): GsShopImportDeps["store"] & { upserted: NormalizedOrder[] } {
    const upserted: NormalizedOrder[] = [];
    return {
      upserted,
      async upsertOrders(orders, _tenantId) {
        upserted.push(...orders);
        return upserted.length;
      },
    };
  }

  it("reports 503 when the import pipeline isn't configured", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const res = await app.inject({ method: "POST", url: "/api/imports/gsshop" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("parses the uploaded file and upserts through the configured store", async () => {
    const store = fakeStore();
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      gsshopImport: { store },
    });
    const buffer = await buildWorkbook(FULL_HEADERS, [
      ["GS1", "2026-07-01 10:00", "배송중", "홍길동", "P1", "상품A", 2, 20000],
    ]);
    const boundary = "----testboundary123";
    const res = await app.inject({
      method: "POST",
      url: "/api/imports/gsshop",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: buildMultipartBody(boundary, "tenant-1", buffer),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ordersImported).toBe(1);
    expect(body.rowErrors).toEqual([]);
    expect(store.upserted).toHaveLength(1);
    expect(store.upserted[0]!.marketplace).toBe("gsshop");
    await app.close();
  });

  it("returns 422 with a clear message when the file isn't a GS샵 주문리스트 export", async () => {
    const { app } = buildApp({ NODE_ENV: "test" } as NodeJS.ProcessEnv, {
      gsshopImport: { store: fakeStore() },
    });
    const buffer = await buildWorkbook(["아무 헤더"], [["x"]]);
    const boundary = "----testboundary456";
    const res = await app.inject({
      method: "POST",
      url: "/api/imports/gsshop",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: buildMultipartBody(boundary, "tenant-1", buffer),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain("주문번호");
    await app.close();
  });
});
