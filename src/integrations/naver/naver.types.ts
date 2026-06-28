import { z } from "zod";

/**
 * zod schemas for the RAW 네이버 커머스 API payloads we consume.
 *
 * "Validate at the edge" (ARCHITECTURE.md §6): every external JSON is parsed
 * here before the mapper touches it, so a shape change surfaces as a loud,
 * located error instead of a silent wrong number downstream. Schemas are
 * deliberately PERMISSIVE — `.passthrough()` keeps unknown fields (we retain the
 * raw payload for audit), and we only *require* the handful of fields we map.
 *
 * KRW money fields arrive as JSON numbers already in won (no minor-unit scaling
 * on Naver's side); we coerce + floor to integers to honour the integer-KRW rule.
 */

const intKrw = z.coerce.number().finite().transform((n) => Math.round(n));

/** GET /external/v1/pay-order/seller/product-orders/last-changed-statuses */
export const LastChangedStatusItem = z
  .object({
    productOrderId: z.string(),
    productOrderStatus: z.string().optional(),
    lastChangedDate: z.string().optional(),
  })
  .passthrough();

export const LastChangedStatusesResponse = z
  .object({
    timestamp: z.string().optional(),
    data: z
      .object({
        lastChangeStatuses: z.array(LastChangedStatusItem).default([]),
        // Naver signals "more pages" via a `more` block carrying the cursor to
        // resume from. Present only when the window was truncated.
        more: z
          .object({
            moreSequence: z.string().optional(),
            moreFrom: z.string().optional(),
          })
          .passthrough()
          .optional(),
        count: z.coerce.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** POST /external/v1/pay-order/seller/product-orders/query (one element) */
export const ProductOrderDetail = z
  .object({
    productOrder: z
      .object({
        productOrderId: z.string(),
        productOrderStatus: z.string().optional().default("UNKNOWN"),
        productName: z.string().optional().default(""),
        productId: z.union([z.string(), z.number()]).optional(),
        quantity: z.coerce.number().optional().default(0),
        unitPrice: intKrw.optional(),
        totalPaymentAmount: intKrw.optional(),
        totalProductAmount: intKrw.optional(),
      })
      .passthrough(),
    order: z
      .object({
        orderId: z.string(),
        ordererName: z.string().optional().nullable(),
        orderDate: z.string().optional(),
        paymentDate: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const ProductOrderQueryResponse = z
  .object({
    timestamp: z.string().optional(),
    data: z.array(ProductOrderDetail).default([]),
  })
  .passthrough();

/** POST /external/v1/products/search (channel product listing) */
export const ChannelProduct = z
  .object({
    channelProductNo: z.union([z.string(), z.number()]),
    name: z.string().optional().default(""),
    salePrice: intKrw.optional(),
    stockQuantity: z.coerce.number().optional().default(0),
    statusType: z.string().optional().default("UNKNOWN"),
  })
  .passthrough();

export const ProductSearchItem = z
  .object({
    originProductNo: z.union([z.string(), z.number()]).optional(),
    channelProducts: z.array(ChannelProduct).default([]),
  })
  .passthrough();

export const ProductSearchResponse = z
  .object({
    contents: z.array(ProductSearchItem).default([]),
    totalElements: z.coerce.number().optional().default(0),
    totalPages: z.coerce.number().optional().default(0),
    page: z.coerce.number().optional().default(1),
    size: z.coerce.number().optional().default(0),
  })
  .passthrough();

export type LastChangedStatusesResponseT = z.infer<
  typeof LastChangedStatusesResponse
>;
export type ProductOrderDetailT = z.infer<typeof ProductOrderDetail>;
export type ProductOrderQueryResponseT = z.infer<
  typeof ProductOrderQueryResponse
>;
export type ProductSearchResponseT = z.infer<typeof ProductSearchResponse>;
