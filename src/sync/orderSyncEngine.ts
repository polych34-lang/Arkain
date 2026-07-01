import type {
  MarketplaceAdapter,
  MarketplaceId,
  NormalizedOrder,
  SellerCredential,
} from "../integrations/marketplace.js";

/**
 * ENG-Orders-MVP (ARK-5): the sync engine that turns the ARK-3 adapter + ARK-4
 * domain model into a running poll loop. It only ever talks to
 * `MarketplaceAdapter` and normalized types (ARCHITECTURE.md §5) — nothing
 * here is Naver-specific, so a second marketplace registers another adapter
 * in the `adapters` map and needs no engine changes.
 *
 * Retry/backoff already lives in the adapter's HTTP client (one policy for
 * all marketplaces, see integrations/retry.ts) — this engine does not retry.
 */

/** A connection with its credential already decrypted, just for this sync call
 * (ARCHITECTURE.md §7: just-in-time access, no standing plaintext). */
export interface SyncConnection {
  id: string;
  marketplace: MarketplaceId;
  credential: SellerCredential;
}

/** The subset of `PrismaDomainStore` the engine depends on — narrow enough to
 * fake in tests without a database. */
export interface OrderSyncStore {
  getLastCursor(connectionId: string): Promise<string | undefined>;
  recordSyncStart(connectionId: string): Promise<string>;
  recordSyncFinish(
    runId: string,
    result: {
      status: "success" | "failed";
      ordersPulled: number;
      cursor?: string;
      error?: string;
    },
  ): Promise<void>;
  upsertOrders(orders: NormalizedOrder[]): Promise<number>;
}

export interface SyncSummary {
  connectionId: string;
  marketplace: MarketplaceId;
  /** Orders fetched from the marketplace this cycle (across all pages). */
  ordersFetched: number;
  /** Total orders now on file for this seller, post-upsert. */
  totalOrders: number;
  status: "success" | "failed";
  error?: string;
}

export interface OrderSyncEngineOptions {
  /** Lookback window for a connection that has never synced. Default 14 days. */
  defaultSinceDays?: number;
  /** Safety cap on pages pulled per connection per cycle, so one noisy
   * connection can't starve the others sharing this process. Default 50. */
  maxPagesPerCycle?: number;
  onError?: (connectionId: string, error: unknown) => void;
}

export class OrderSyncEngine {
  private readonly defaultSinceMs: number;
  private readonly maxPagesPerCycle: number;
  private readonly onError?: (connectionId: string, error: unknown) => void;

  constructor(
    private readonly adapters: Partial<Record<MarketplaceId, MarketplaceAdapter>>,
    private readonly store: OrderSyncStore,
    options: OrderSyncEngineOptions = {},
  ) {
    this.defaultSinceMs = (options.defaultSinceDays ?? 14) * 24 * 60 * 60 * 1000;
    this.maxPagesPerCycle = options.maxPagesPerCycle ?? 50;
    this.onError = options.onError;
  }

  /** Pull every page available for one connection and upsert it. Idempotent —
   * safe to re-run (e.g. after a crash mid-cycle) since upserts key on
   * `(marketplace, marketplaceOrderId)`. */
  async syncConnection(conn: SyncConnection): Promise<SyncSummary> {
    const adapter = this.adapters[conn.marketplace];
    if (!adapter) {
      const error = `no adapter registered for marketplace "${conn.marketplace}"`;
      this.onError?.(conn.id, new Error(error));
      return {
        connectionId: conn.id,
        marketplace: conn.marketplace,
        ordersFetched: 0,
        totalOrders: 0,
        status: "failed",
        error,
      };
    }

    const runId = await this.store.recordSyncStart(conn.id);
    const since = new Date(Date.now() - this.defaultSinceMs);
    let cursor = await this.store.getLastCursor(conn.id);
    let ordersFetched = 0;
    let totalOrders = 0;
    let pages = 0;

    try {
      do {
        const page = await adapter.fetchOrders(conn.credential, { since, cursor });
        ordersFetched += page.orders.length;
        if (page.orders.length > 0) {
          totalOrders = await this.store.upsertOrders(page.orders);
        }
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < this.maxPagesPerCycle);

      await this.store.recordSyncFinish(runId, {
        status: "success",
        ordersPulled: ordersFetched,
        cursor,
      });
      return {
        connectionId: conn.id,
        marketplace: conn.marketplace,
        ordersFetched,
        totalOrders,
        status: "success",
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.store.recordSyncFinish(runId, {
        status: "failed",
        ordersPulled: ordersFetched,
        cursor,
        error,
      });
      this.onError?.(conn.id, err);
      return {
        connectionId: conn.id,
        marketplace: conn.marketplace,
        ordersFetched,
        totalOrders,
        status: "failed",
        error,
      };
    }
  }

  /** One poll cycle across every connection. Connections are synced
   * sequentially — simple and correct for the MVP's connection count; revisit
   * only if sync volume makes that a bottleneck (ARCHITECTURE.md §2/§4). */
  async syncAll(connections: SyncConnection[]): Promise<SyncSummary[]> {
    const results: SyncSummary[] = [];
    for (const conn of connections) {
      results.push(await this.syncConnection(conn));
    }
    return results;
  }

  /** In-process poller (ARCHITECTURE.md §2: no queue for the MVP).
   * `loadConnections` is called fresh each tick so credentials are decrypted
   * just-in-time and never held between ticks. Ticks never overlap. */
  startScheduler(
    loadConnections: () => Promise<SyncConnection[]>,
    intervalMs: number,
  ): { stop(): void } {
    let stopped = false;
    let running = false;

    const tick = async (): Promise<void> => {
      if (stopped || running) return;
      running = true;
      try {
        const connections = await loadConnections();
        await this.syncAll(connections);
      } catch (err) {
        this.onError?.("scheduler", err);
      } finally {
        running = false;
      }
    };

    const handle = setInterval(() => void tick(), intervalMs);
    handle.unref?.();
    return {
      stop: () => {
        stopped = true;
        clearInterval(handle);
      },
    };
  }
}
