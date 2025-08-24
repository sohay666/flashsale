import {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  expect,
} from "@jest/globals";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { routes } from "../src/routes";
import { redis, initTxPool, closeTxPool } from "../src/services/redis";
import { makeApp, getCsrf, resetSale } from "./helpers";
import { v4 as uuidV4 } from "uuid";

let app: any;

describe("purchase concurrency (no oversell)", () => {
  beforeAll(async () => {
    process.env.DISABLE_RATELIMIT = "1"; // disable your rate limiter in tests
    await initTxPool();
    app = await makeApp();
    jest.setTimeout(20000);
  });

  afterAll(async () => {
    await app.close();
    await redis.flushall();
    await redis.quit();
    await closeTxPool(); // quit pooled duplicate clients
  });

  beforeEach(async () => {
    const now = Date.now();
    await resetSale({
      startsAt: now - 10_000,
      endsAt: now + 60_000,
      stock: 10,
    });
  });

  it("exactly N succeed; rest are sold_out", async () => {
    const { token, cookie } = await getCsrf(app);
    const N = 10;
    const M = 35;
    const uuid = uuidV4();
    const attempts = Array.from({ length: M }, (_, i) =>
      app.inject({
        method: "POST",
        url: "/api/purchase",
        headers: {
          cookie: cookie,
          "content-type": "application/json",
          "x-csrf-token": token,
          "Correlation-Id": uuid,
        },
        payload: { userId: `c_${i}@example.com` },
      })
    );

    const res = await Promise.all(attempts);
    const ok = res.filter((r) => r.statusCode === 200).length;
    const sold = res.filter((r) => r.statusCode === 410).length;
    const other = res.filter(
      (r) => ![200, 410, 409, 403].includes(r.statusCode)
    );

    expect(ok).toBe(N);
    expect(sold).toBe(M - N);
    expect(other.length).toBe(0);
    expect(Number(await redis.get("sale:stock"))).toBe(0);
  });
});
