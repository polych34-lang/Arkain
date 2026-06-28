import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  NormalizedOrder,
  NormalizedProduct,
} from "../integrations/marketplace.js";

/**
 * Dead-simple local JSON store for the spike — "pull into local storage" without
 * standing up Postgres. Upserts are idempotent, keyed exactly like the real DB
 * will be (orders by `(marketplace, marketplaceOrderId)`, products by
 * `(marketplace, marketplaceProductId)`), so re-running a sync never
 * double-counts. ENG-Domain-Model swaps this for Prisma without touching adapters
 * or the CLI — both speak the same normalized types.
 */

export interface SyncRunSummary {
  marketplace: string;
  startedAt: string;
  finishedAt: string;
  ordersPulled: number;
  productsPulled: number;
  status: "success" | "failed";
  error?: string;
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export class JsonFileStore {
  constructor(private readonly dir: string) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  /** Upsert orders by `marketplaceOrderId`; returns the new total count. */
  async upsertOrders(orders: NormalizedOrder[]): Promise<number> {
    await this.ensureDir();
    const file = this.path("orders.json");
    const existing = await readJsonArray<NormalizedOrder>(file);
    const merged = new Map(
      existing.map((o) => [`${o.marketplace}:${o.marketplaceOrderId}`, o]),
    );
    for (const o of orders) {
      merged.set(`${o.marketplace}:${o.marketplaceOrderId}`, o);
    }
    const out = [...merged.values()];
    await writeFile(file, JSON.stringify(out, null, 2), "utf8");
    return out.length;
  }

  /** Upsert products by `marketplaceProductId`; returns the new total count. */
  async upsertProducts(products: NormalizedProduct[]): Promise<number> {
    await this.ensureDir();
    const file = this.path("products.json");
    const existing = await readJsonArray<NormalizedProduct>(file);
    const merged = new Map(
      existing.map((p) => [`${p.marketplace}:${p.marketplaceProductId}`, p]),
    );
    for (const p of products) {
      merged.set(`${p.marketplace}:${p.marketplaceProductId}`, p);
    }
    const out = [...merged.values()];
    await writeFile(file, JSON.stringify(out, null, 2), "utf8");
    return out.length;
  }

  /** Append an audit record of the sync run (the local SyncRun analogue). */
  async appendSyncRun(summary: SyncRunSummary): Promise<void> {
    await this.ensureDir();
    const file = this.path("sync-runs.json");
    const existing = await readJsonArray<SyncRunSummary>(file);
    existing.push(summary);
    await writeFile(file, JSON.stringify(existing, null, 2), "utf8");
  }
}
