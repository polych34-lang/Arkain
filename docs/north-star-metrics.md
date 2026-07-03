# North Star metrics engine: CCR/미수에이징/견적전환율/건강점수 (ARK-38)

**Status:** single-service design + implementation, unit-tested (no DB
required — see "Verification" below). Source reasoning is
[ARK-32](/ARK/issues/ARK-32#document-feature-audit) §2.5/§4; this doc is the
implementation summary + the decisions made turning that design into code.

## What this is

A single tenant-scoped `computeNorthStar()` (`src/domain/northStar.ts`)
replacing the reference OMS's pattern of computing CCR/미수에이징/견적전환율
separately per screen (4x duplicated — the v459 bug this issue explicitly
calls out). Built as small pure functions (each independently unit-tested)
plus one thin I/O orchestrator, the same split `src/domain/accounting.ts`
(`buildSalesJournalLines` / `postSalesJournalEntry`) already established.

```
computeNorthStar(prisma, tenantId, options)
  |-- fetch: JournalLine(108 외상매출금) + JournalLine(404 매출, CREDIT) + BankTransaction(DEPOSIT) + Quote.count
  |
  |-- computeAgingFifo(arLines, asOf, boundariesDays)      -> 미수에이징 4버킷 + 거래처별미수 + 90일+비중
  |-- computeCcrByMonth(revenueLines, cashLines, monthKeyFn) -> 월별 CCR
  |-- computeQuoteConversion(sentCount, acceptedCount)      -> 견적전환율
  '-- computeHealthScore({cashScore, receivablesScore, conversionScore, marginScore, speedScore}) -> 건강점수
```

## v458/459/460/466 lessons, and where each is enforced

| Lesson | Where enforced |
| --- | --- |
| v458 (분모⊂분자 → 항상 100%) | `computeQuoteConversion` **throws** `NorthStarInvariantError` if `acceptedCount > sentCount`. Denominator is `Quote.status IN (SENT, ACCEPTED, EXPIRED)` — quotes actually sent out — never "quotes with an order" (`Quote.status` is app-controlled, defaults to `DRAFT`, never auto-flips to `ACCEPTED`). |
| v459 (계산로직 4중복) | One service, `src/domain/northStar.ts`. No screen/report computes CCR or aging independently. |
| v460 (전역함수 착각 → 크래시) | `test/northStar.test.ts` actually runs every function (20 unit tests + one end-to-end test against a fake Prisma client), not just `tsc --noEmit`. |
| v466 (월키 포맷 불일치 → CCR 0%) | `monthKeyFn` and `asOf` are both constructor options (default `YYYY-MM` / `new Date()`), never hardcoded inside the calculation functions. `agingBucketsDays` is likewise injectable. |

## Formulas

- **CCR(월)** = 그 달 DEPOSIT `BankTransaction` 합계 / 그 달 인식된 매출(`JournalLine` 404 CREDIT) 합계. `ccr` is `null` (not `0`) when that month had no recognized revenue — avoids the exact "CCR 0%" misreading v466 caused.
- **미수에이징** — FIFO per `AccPartner`: each partner's `108` DEBIT lines (invoices), oldest first, are paid down by that partner's pooled `108` CREDIT lines (collections) before any remainder is aged by `asOf - entryDate`. Default buckets: `0-30 / 31-60 / 61-90 / 90+`.
- **90일+미수비중** = 90+ bucket total / total open AR. `null` (not `0`) when there is no open AR.
- **견적전환율** = `COUNT(Quote WHERE status = ACCEPTED)` / `COUNT(Quote WHERE status IN (SENT, ACCEPTED, EXPIRED))`. `null` when nothing has been sent yet.
- **건강점수** = weighted average of `{cashScore: 30%, receivablesScore: 20%, conversionScore: 20%, marginScore: 20%, speedScore: 10%}`, **renormalized over whichever axes are non-null** — a missing axis is excluded from the average, never treated as 0.
  - `cashScore` = average of the last 3 months' CCR, clamped to `[0,100]`.
  - `receivablesScore` = `(1 - 90일+비중) * 100`; `100` when there's no open AR at all.
  - `conversionScore` = 견적전환율 * 100.

## Known gaps (tracked, not blocking)

- **마진(margin)/속도(speed) axes have no data source in the schema yet.**
  `Order`/`Product` have no cost/원가 field, and `Order` has no
  per-fulfillment-stage timestamp (`OrderStatus` has `DISPATCHED`/`DELIVERED`
  values but no matching `dispatchedAt`/`deliveredAt` columns to compute a
  cycle-time). `computeNorthStar`'s `marginScore`/`speedScore` options are
  `null` unless a caller supplies them — the health score renormalizes over
  the 3 available axes (70% of the total weight) rather than fabricating a
  number for either. Adding those data sources is a separate schema issue.
- **CCR's `cashCollectedKrw` is a proxy** (tenant `DEPOSIT` `BankTransaction`s
  in the month), not invoice-matched collections — `docs/accounting-module.md`
  already documents that bank-transaction-to-invoice matching
  (`BankRule`/matching logic) isn't wired yet. Once it lands, CCR should
  switch to matched collections only; until then this is the best signal
  available from existing tables.
- **AR aging is FIFO, not per-invoice-matched.** There's no schema link from
  a `108` CREDIT line back to the specific `108` DEBIT line it settles
  (same underlying gap as the CCR proxy above), so aging assumes oldest-debt-
  paid-first per partner. Standard fallback when that link is missing; not
  exact if a seller collects out of invoice order.
- **No wiring into a live dashboard/API route yet.** This issue is schema-
  free (reads existing `JournalLine`/`BankTransaction`/`Quote` tables) and
  logic-only, matching the accounting module's schema-and-logic-first
  posture. Exposing `computeNorthStar` through an HTTP route/UI is a
  follow-up.

## Verification

Same constraint as the other domain-model docs: no reachable real Postgres in
this environment.

- **Pure functions** (`computeAgingFifo`, `computeCcrByMonth`,
  `computeQuoteConversion`, `computeHealthScore`, and the score-mapping
  helpers) — fully unit-tested, no I/O.
- **`computeNorthStar` orchestration** — one end-to-end test against an
  in-memory fake Prisma client (same pattern as `test/accounting.test.ts`),
  covering the full pipeline: seeded `JournalLine`/`BankTransaction`/`Quote`
  rows through `forTenant`'s `$extends` wrapping to the final result.
- `npm run typecheck` and `npm test` both pass (145 tests, including the 20
  new ones).
