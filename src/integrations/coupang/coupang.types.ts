import { z } from "zod";

/**
 * zod schemas for the RAW 쿠팡 Wing/Open API payloads we consume.
 * "Validate at the edge" (ARCHITECTURE.md §6): every external JSON is parsed
 * here before the mapper touches it.
 *
 * Field names/shapes are transcribed from the public Coupang Open API
 * reference (발주서 목록 조회 / 상품 목록 조회), NOT from a live vendor account (no
 * Coupang WING credentials exist yet — same caveat as ESM 2.0 pre-ARK-11
 * creds). Schemas are deliberately permissive (`.passthrough()`, optional
 * fields) so an unverified assumption about a field's presence doesn't crash
 * the adapter; only the handful of fields we map are required. See
 * docs/coupang-integration.md §6 for exactly what's assumed vs confirmed.
 *
 * Money fields arrive as numbers per the docs we could find; coerced +
 * rounded to honour the integer-KRW rule anyway (defensive, same as Naver/ESM).
 */

const intKrw = z.coerce.number().finite().transform((n) => Math.round(n));

/** One line item on a 발주서 (order sheet). */
export const CoupangOrderItem = z
  .object({
    vendorItemId: z.coerce.string(),
    vendorItemName: z.string().optional().default(""),
    shippingCount: z.coerce.number().optional().default(1),
    salesPrice: intKrw.optional(),
    orderPrice: intKrw.optional(),
  })
  .passthrough();

/** GET /v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets — one order sheet. */
export const CoupangOrderSheet = z
  .object({
    shipmentBoxId: z.coerce.number(),
    orderId: z.coerce.string().optional(),
    orderedAt: z.string().optional(),
    paidAt: z.string().optional(),
    status: z.string().optional().default("UNKNOWN"),
    orderer: z
      .object({ name: z.string().optional() })
      .passthrough()
      .optional(),
    orderItems: z.array(CoupangOrderItem).default([]),
  })
  .passthrough();

export const CoupangOrderSheetsResponse = z
  .object({
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string().optional().default(""),
    nextToken: z.string().optional().nullable(),
    data: z.array(CoupangOrderSheet).default([]),
  })
  .passthrough();

/** One sale item under a seller product listing (an option/SKU). */
export const CoupangSellerProductItem = z
  .object({
    vendorItemId: z.coerce.string(),
    itemName: z.string().optional().default(""),
    salePrice: intKrw.optional(),
    stockQuantity: z.coerce.number().optional().default(0),
    saleStatusName: z.string().optional().default("UNKNOWN"),
  })
  .passthrough();

/** GET /v2/providers/seller_api/apis/api/v1/marketplace/seller-products — one listing. */
export const CoupangSellerProduct = z
  .object({
    sellerProductId: z.coerce.string(),
    sellerProductName: z.string().optional().default(""),
    items: z.array(CoupangSellerProductItem).default([]),
  })
  .passthrough();

export const CoupangSellerProductsResponse = z
  .object({
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string().optional().default(""),
    nextToken: z.string().optional().nullable(),
    data: z.array(CoupangSellerProduct).default([]),
  })
  .passthrough();

export type CoupangOrderItemT = z.infer<typeof CoupangOrderItem>;
export type CoupangOrderSheetT = z.infer<typeof CoupangOrderSheet>;
export type CoupangOrderSheetsResponseT = z.infer<typeof CoupangOrderSheetsResponse>;
export type CoupangSellerProductItemT = z.infer<typeof CoupangSellerProductItem>;
export type CoupangSellerProductT = z.infer<typeof CoupangSellerProduct>;
export type CoupangSellerProductsResponseT = z.infer<typeof CoupangSellerProductsResponse>;
