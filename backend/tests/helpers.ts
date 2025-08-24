import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { routes } from "../src/routes";
import { redis } from "../src/services/redis";

export async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(routes);
  await app.ready();
  return app;
}

export async function resetSale({
  startsAt,
  endsAt,
  stock,
}: {
  startsAt: number;
  endsAt: number;
  stock: number;
}) {
  await redis.flushall();
  // set config + stock directly
  await redis.hset("sale:config", {
    productId: "LE-001",
    startsAt: String(startsAt),
    endsAt: String(endsAt),
    initialStock: String(stock),
  });
  await redis.set("sale:stock", stock);
}

export async function getStatus() {
  const cfg = await redis.hgetall("sale:config");
  const stock = Number(await redis.get("sale:stock")) || 0;
  const startsAt = Number(cfg.startsAt);
  const endsAt = Number(cfg.endsAt);
  const now = Date.now();
  let status: "upcoming" | "active" | "ended" | "sold_out" = "active";
  if (now < startsAt) status = "upcoming";
  else if (now > endsAt) status = "ended";
  else if (stock <= 0) status = "sold_out";
  return { status, startsAt, endsAt, stock };
}

// supertest import (CJS-friendly)
export const request: any = require("supertest");

// Fetch CSRF token + cookie using the API
export async function getCsrf(app: FastifyInstance) {
  const res = await request(app.server).get("/api/csrf");
  const token = res.body?.csrfToken as string;
  const cookie = res.headers["set-cookie"]?.[0] as string;
  if (!token || !cookie) throw new Error("Failed to fetch CSRF token/cookie");
  return { token, cookie };
}
