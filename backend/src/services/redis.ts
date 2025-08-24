import IORedis, { Redis } from "ioredis";
import { loadSaleConfig } from "../config";

// Shared base client (auto-connect)
export const redis = new IORedis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    db: Number(process.env.REDIS_DB || 0),
  }
);

// TX connection pool (dedicated clients for WATCH/MULTI/EXEC)
const POOL_SIZE = Number(process.env.REDIS_TX_POOL || 8);
const txPool: Redis[] = [];
let rr = 0;
let poolInitPromise: Promise<void> | null = null;

export async function ensureConnected(c: Redis) {
  if (c.status === "ready") return;
  if (c.status === "connecting" || c.status === "connect") {
    await new Promise<void>((resolve) => c.once("ready", () => resolve()));
    return;
  }
  await c.connect();
}

export function getTxConn(): Redis {
  if (!txPool.length) {
    throw new Error(
      "TX pool not initialized. Call initTxPool() during startup."
    );
  }
  const c = txPool[rr++ % txPool.length];
  return c;
}

export async function initTxPool() {
  if (txPool.length) return;
  if (poolInitPromise) return poolInitPromise;
  poolInitPromise = (async () => {
    const tasks: Promise<any>[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      // Use lazyConnect so can control when to connect (avoids 'already connecting' error)
      const c = redis.duplicate({ lazyConnect: true }) as unknown as Redis;
      txPool.push(c);
      tasks.push(ensureConnected(c));
    }
    await Promise.all(tasks);
  })();
  return poolInitPromise;
}

// Bootstrap sale config/stock
export async function bootstrapSale() {
  const cfg = loadSaleConfig();
  const exists = await redis.exists("sale:stock");
  if (!exists) {
    await redis.set("sale:stock", cfg.initialStock);
  }
  await redis.hset("sale:config", {
    productId: cfg.productId,
    productDescription: cfg.productDescription,
    startsAt: String(cfg.startsAt),
    endsAt: String(cfg.endsAt),
    initialStock: String(cfg.initialStock),
  });
}

// closeTxPool: Graceful shutdown helper
export async function closeTxPool() {
  await Promise.all(
    txPool.map(async (c) => {
      try {
        await c.quit();
      } catch {}
    })
  );
  txPool.length = 0;
  poolInitPromise = null;
}
