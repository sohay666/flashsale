import { FastifyRequest, FastifyReply } from "fastify";
import { redis } from "../services/redis";

export async function rateLimit(req: FastifyRequest, rep: FastifyReply) {
  if (process.env.DISABLE_RATELIMIT === "1") return;
  const key = `ratelimit:${req.ip}`;
  const ttl = 10_000; // 10s
  const max = 20;
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, ttl);
  if (count > max) return rep.code(429).send({ error: "rate_limited" });
}
