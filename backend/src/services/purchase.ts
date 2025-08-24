import { FastifyReply, FastifyRequest } from "fastify";
import { redis, getTxConn, ensureConnected } from "./redis";

const MAX_RETRIES = Number(process.env.PURCHASE_MAX_RETRIES || 5);
const BACKOFF_MS_BASE = Number(process.env.PURCHASE_RETRY_BACKOFF_MS || 2);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET /api/purchase/:userId
 *
 * Returns whether a given user has already secured the flash-sale item.
 *
 * Behavior:
 * - Validates the `userId` path param (min length: 3). On failure → 422 { error: "invalid_user" }.
 * - Looks up Redis key `user:<userId>` which stores the generated orderId when a purchase succeeds.
 * - Responds with:
 *     200 { purchased: true,  orderId: "<id>" }   // when key exists
 *     200 { purchased: false, orderId: null }     // when key does not exist
 *
 * Notes:
 * - Read-only/idempotent; safe to poll.
 * - Independent of sale window; it just reports current state.
 * - CSRF is not required for GET.
 */
export async function getPurchase(req: FastifyRequest, rep: FastifyReply) {
  const { userId } = req.params as any;
  if (!userId || String(userId).trim().length < 3) {
    return rep.code(422).send({ error: "invalid_user" });
  }

  const key = `user:${String(userId).trim()}`;
  const orderId = await redis.get(key);
  return { purchased: !!orderId, orderId: orderId ?? null };
}

/**
 * POST /api/purchase
 *
 * Attempts to reserve/purchase exactly one unit of the flash-sale product
 * for the given user. Enforces “one item per user”, respects the sale
 * window, and prevents oversell via an atomic Redis transaction.
 *
 * Input:
 *   Body: { userId: string }   // min length 3
 *
 * Reads:
 *   - Redis hash "sale:config" for { startsAt, endsAt }
 *   - Redis keys used by attemptPurchase(): "sale:stock", "user:<userId>"
 *
 * Response (status → JSON):
 *   200 -> { status: "purchased", orderId }
 *   409 -> { status: "already_purchased", orderId }
 *   410 -> { status: "sold_out" }
 *   403 -> { status: "not_active" }                // outside sale window
 *   503 -> { status: "busy", retryAfterMs: 50 }    // high contention
 *   422 -> { error: "invalid_user" }               // bad payload
 *   500 -> { error: "unknown" }
 *
 * Notes:
 *   - CSRF: protect this route with a preHandler (e.g. csrfPreHandler)
 *     that validates/rotates the token before this handler runs.
 *   - Idempotency: clients SHOULD send an "Idempotency-Key" header; the
 *     purchase semantics are naturally idempotent per userId.
 */
export async function doPurchase(req: FastifyRequest, rep: FastifyReply) {
  const body = req.body as any;
  const userId = String(body?.userId || "").trim();
  if (!userId || userId.length < 3)
    return rep.code(422).send({ error: "invalid_user" });

  const cfg = await redis.hgetall("sale:config");
  const startsAt = Number(cfg.startsAt);
  const endsAt = Number(cfg.endsAt);
  const now = Date.now();

  const r = await attemptPurchase({ userId, now, startsAt, endsAt });
  if (r.code === 0) return { status: "purchased", orderId: r.orderId };
  if (r.code === 1)
    return rep
      .code(409)
      .send({ status: "already_purchased", orderId: r.orderId });
  if (r.code === 2) return rep.code(410).send({ status: "sold_out" });
  if (r.code === 3) return rep.code(403).send({ status: "not_active" });
  if (r.code === 4)
    return rep.code(503).send({ status: "busy", retryAfterMs: 50 });
  return rep.code(500).send({ error: "unknown" });
}

async function attemptPurchase({
  userId,
  now,
  startsAt,
  endsAt,
}: {
  userId: string;
  now: number;
  startsAt: number;
  endsAt: number;
}) {
  const stockKey = "sale:stock";
  const userKey = `user:${userId}`;

  const conn = getTxConn();
  await ensureConnected(conn);

  for (let tries = 0; tries < MAX_RETRIES; tries++) {
    await conn.watch(stockKey, userKey);

    // window check
    if (now < startsAt || now > endsAt) {
      await conn.unwatch();
      return { code: 3 as const };
    }

    const [stockStr, existing] = await conn.mget(stockKey, userKey);
    if (existing) {
      await conn.unwatch();
      return { code: 1 as const, orderId: existing };
    }

    const stock = Number(stockStr || "0");
    if (!Number.isFinite(stock) || stock <= 0) {
      await conn.unwatch();
      return { code: 2 as const };
    }

    const orderId = `${now}:${userId}`;

    const res = await conn
      .multi()
      .decr(stockKey)
      .set(userKey, orderId)
      .lpush("sale:orders", JSON.stringify({ userId, ts: now, orderId }))
      .exec(); // null on conflict

    if (!res) {
      await conn.unwatch();
      const backoff = BACKOFF_MS_BASE * (1 + Math.random()) * (1 + tries);
      await sleep(backoff);
      continue;
    }

    const newStock = Number(res[0]?.[1]); // reply from DECR
    if (Number.isFinite(newStock) && newStock < 0) {
      await conn.multi().incr(stockKey).del(userKey).exec(); // guard rollback
      return { code: 2 as const };
    }

    return { code: 0 as const, orderId };
  }

  await conn.unwatch();
  return { code: 4 as const, reason: "contention" };
}
