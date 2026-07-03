/**
 * ENG-Orders-MVP (ARK-5) demo seed: writes a handful of realistic,
 * Naver-shaped orders directly through the same unified pipeline the sync
 * engine uses (`toOrderScalarFields`/`upsertOrders`), so the dashboard can be
 * demoed end-to-end before the ARK-3 Naver credential blocker clears.
 *
 * This is fabricated illustrative data, not a real seller's orders — no
 * marketplace call is made and no credential is touched.
 *
 *   npm run seed:demo
 */
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env.js";
import type { NormalizedOrder } from "../integrations/marketplace.js";
import { PrismaDomainStore } from "../domain/repository.js";
import { hashPassword } from "../auth/password.js";

// ARK-57: fixed demo login so the CEO/QA can walk the full 로그인 → 상품등록 →
// 주문확인 flow against this seeded tenant without signing up a fresh one.
const DEMO_EMAIL = "demo@arkain.dev";
const DEMO_PASSWORD = "demo1234!";

const DEMO_ORDERS: NormalizedOrder[] = [
  {
    marketplace: "naver_smartstore",
    marketplaceOrderId: "DEMO-ORD-1001",
    orderedAt: "2026-06-30T00:12:00.000Z",
    status: "PAYED",
    buyerName: "김민준",
    totalAmountKrw: 38_000,
    items: [
      { marketplaceProductId: "DEMO-P-1", productName: "유기농 현미 2kg", quantity: 2, unitPriceKrw: 19_000 },
    ],
    raw: { demo: true },
  },
  {
    marketplaceOrderId: "DEMO-ORD-1002",
    marketplace: "naver_smartstore",
    orderedAt: "2026-06-30T03:45:00.000Z",
    status: "DELIVERING",
    buyerName: "이서연",
    totalAmountKrw: 52_500,
    items: [
      { marketplaceProductId: "DEMO-P-2", productName: "홍삼정 스틱 30포", quantity: 1, unitPriceKrw: 45_000 },
      { marketplaceProductId: "DEMO-P-3", productName: "종이 쇼핑백", quantity: 1, unitPriceKrw: 7_500 },
    ],
    raw: { demo: true },
  },
  {
    marketplaceOrderId: "DEMO-ORD-1003",
    marketplace: "naver_smartstore",
    orderedAt: "2026-06-29T22:05:00.000Z",
    status: "PURCHASE_DECIDED",
    buyerName: "박지호",
    totalAmountKrw: 12_900,
    items: [{ marketplaceProductId: "DEMO-P-4", productName: "수제 그래놀라 500g", quantity: 1, unitPriceKrw: 12_900 }],
    raw: { demo: true },
  },
  {
    marketplaceOrderId: "DEMO-ORD-1004",
    marketplace: "naver_smartstore",
    orderedAt: "2026-06-29T18:30:00.000Z",
    status: "CANCELED",
    buyerName: "최유진",
    totalAmountKrw: 24_000,
    items: [{ marketplaceProductId: "DEMO-P-1", productName: "유기농 현미 2kg", quantity: 1, unitPriceKrw: 19_000 }],
    raw: { demo: true, cancelReason: "단순 변심" },
  },
  {
    marketplaceOrderId: "DEMO-ORD-1005",
    marketplace: "naver_smartstore",
    orderedAt: "2026-06-28T09:15:00.000Z",
    status: "PAYMENT_WAITING",
    buyerName: "정하늘",
    totalAmountKrw: 91_000,
    items: [{ marketplaceProductId: "DEMO-P-5", productName: "선물세트 A", quantity: 1, unitPriceKrw: 91_000 }],
    raw: { demo: true },
  },
];

async function main(): Promise<void> {
  const config = loadEnv();
  if (!config.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run `docker compose up -d` + `npm run db:migrate` first.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const store = new PrismaDomainStore(prisma);
  // ARK-10: orders are tenant-scoped now, so the demo needs a demo tenant.
  // ARK-57: that tenant now also needs login credentials so /login can reach
  // it. Always (re-)set them on the fixed `DEMO_EMAIL`/`DEMO_PASSWORD` pair —
  // this is fabricated demo data, not a real seller, so a predictable login
  // across re-runs matters more than "don't silently rotate a credential"
  // (which is what protects a *real* seller's password elsewhere).
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const demoSeller = await prisma.seller.upsert({
    where: { id: "demo-seller" },
    create: { id: "demo-seller", displayName: "데모 셀러", email: DEMO_EMAIL, passwordHash },
    update: { email: DEMO_EMAIL, passwordHash },
  });
  const total = await store.upsertOrders(DEMO_ORDERS, demoSeller.id);
  console.log(`Seeded ${DEMO_ORDERS.length} demo orders (tenant total: ${total}). Visit /orders to view them.`);
  console.log(`Demo login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
