import { z } from "zod";

/**
 * zod schemas for the RAW ESM Trading API (ESM 2.0, G마켓/옥션) payloads we
 * consume. "Validate at the edge" (ARCHITECTURE.md §6): every external JSON is
 * parsed here before the mapper touches it.
 *
 * Field names/shapes are transcribed from the public ESM Trading API reference
 * (https://etapi.gmarket.com — 주문조회 API, 상품 목록 조회 API), NOT from a live
 * account (no ESM PLUS credentials exist yet — same caveat as Naver pre-ARK-3
 * creds). Schemas are deliberately permissive (`.passthrough()`, optional
 * fields) so an unverified assumption about a field's presence doesn't crash
 * the adapter; only the handful of fields we map are required. See
 * docs/esm-2.0-integration.md §7 for exactly what's assumed vs confirmed.
 *
 * Money fields (SalePrice, AcntMoney, price.gmkt/iac, ...) arrive as either
 * strings or numbers depending on the endpoint per the docs we could find —
 * coerced + rounded to honour the integer-KRW rule.
 */

const intKrw = z.coerce.number().finite().transform((n) => Math.round(n));

/** POST https://sa2.esmplus.com/shipping/v1/Order/RequestOrders — one order row. */
export const EsmOrderRow = z
  .object({
    OrderNo: z.coerce.string(),
    OrderStatus: z.coerce.string().optional().default("UNKNOWN"),
    PayNo: z.coerce.string().optional(),
    OrderDate: z.string().optional(),
    PayDate: z.string().optional(),
    SiteGoodsNo: z.coerce.string().optional().default(""),
    GoodsName: z.string().optional().default(""),
    SalePrice: intKrw.optional(),
    ContrAmount: z.coerce.number().optional().default(0),
    AcntMoney: intKrw.optional(),
    BuyerName: z.string().optional().nullable(),
  })
  .passthrough();

export const EsmOrderSearchResponse = z
  .object({
    ResultCode: z.coerce.number().default(0),
    Message: z.string().optional().default(""),
    Data: z
      .object({
        TotalCount: z.coerce.number().optional().default(0),
        PageIndex: z.coerce.number().optional().default(1),
        PageSize: z.coerce.number().optional().default(0),
        RequestOrders: z.array(EsmOrderRow).default([]),
      })
      .passthrough()
      .optional()
      .default({ RequestOrders: [] }),
  })
  .passthrough();

/** POST https://sa2.esmplus.com/item/v1/goods/search — one product row. */
const perSite = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ gmkt: inner.optional(), iac: inner.optional() }).passthrough();

export const EsmGoodsRow = z
  .object({
    goodsNo: z.coerce.string(),
    goodsName: z.string().optional().default(""),
    price: perSite(intKrw).optional(),
    stock: perSite(z.coerce.number()).optional(),
    sellStatus: perSite(z.coerce.string()).optional(),
    siteGoodsNo: perSite(z.coerce.string()).optional(),
    managedCode: z.string().optional().nullable(),
  })
  .passthrough();

export const EsmGoodsSearchResponse = z
  .object({
    ResultCode: z.coerce.number().optional().default(0),
    Message: z.string().optional().default(""),
    totalItems: z.coerce.number().optional().default(0),
    pageIndex: z.coerce.number().optional().default(1),
    pageSize: z.coerce.number().optional().default(0),
    items: z.array(EsmGoodsRow).default([]),
  })
  .passthrough();

export type EsmOrderRowT = z.infer<typeof EsmOrderRow>;
export type EsmOrderSearchResponseT = z.infer<typeof EsmOrderSearchResponse>;
export type EsmGoodsRowT = z.infer<typeof EsmGoodsRow>;
export type EsmGoodsSearchResponseT = z.infer<typeof EsmGoodsSearchResponse>;
