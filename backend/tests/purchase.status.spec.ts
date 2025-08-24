import {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  expect,
} from "@jest/globals";
import { redis, initTxPool, closeTxPool } from "../src/services/redis";
import { makeApp, resetSale, request, getCsrf } from "./helpers";

let app: any;

describe("purchase status matrix", () => {
  beforeAll(async () => {
    await initTxPool();
    app = await makeApp();
  });

  afterAll(async () => {
    await app.close();
    await redis.flushall();
    await redis.quit();
    await closeTxPool(); // quit pooled duplicate clients
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  it("UPCOMING when purchase is not_active (403)", async () => {
    const now = Date.now();
    await resetSale({
      startsAt: now + 60_000,
      endsAt: now + 3_600_000,
      stock: 5,
    });

    const { token, cookie } = await getCsrf(app);
    const res = await request(app.server)
      .post("/api/purchase")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", token)
      .send({ userId: "upcoming@example.com" });

    expect(res.status).toBe(403);
    expect(res.body?.status || res.body?.error).toBe("not_active");
  });

  it("ACTIVE when first purchase 200, second 409 already_purchased", async () => {
    const now = Date.now();
    await resetSale({ startsAt: now - 10_000, endsAt: now + 60_000, stock: 5 });

    const { token, cookie } = await getCsrf(app);
    const uid = "active@example.com";

    const ok = await request(app.server)
      .post("/api/purchase")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", token)
      .send({ userId: uid });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("purchased");
    expect(ok.body.orderId).toBeDefined();

    const dup = await request(app.server)
      .post("/api/purchase")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", token)
      .send({ userId: uid });
    expect(dup.status).toBe(409);
    expect(dup.body.status).toBe("already_purchased");
  });

  it("ENDED when purchase is not_active (403)", async () => {
    const now = Date.now();
    await resetSale({ startsAt: now - 60_000, endsAt: now - 1_000, stock: 5 });

    const { token, cookie } = await getCsrf(app);
    const res = await request(app.server)
      .post("/api/purchase")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", token)
      .send({ userId: "ended@example.com" });
    expect(res.status).toBe(403);
    expect(res.body.status).toBe("not_active");
  });

  it("SOLD_OUT when with stock=1, second buyer gets 410 sold_out", async () => {
    const now = Date.now();
    await resetSale({ startsAt: now - 10_000, endsAt: now + 60_000, stock: 1 });

    const { token, cookie } = await getCsrf(app);

    const ok = await request(app.server)
      .post("/api/purchase")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", token)
      .send({ userId: "buyer1@example.com" });
    expect(ok.status).toBe(200);

    const soldOut = await request(app.server)
      .post("/api/purchase")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", token)
      .send({ userId: "buyer2@example.com" });
    expect(soldOut.status).toBe(410);
    expect(soldOut.body.status).toBe("sold_out");
  });
});
