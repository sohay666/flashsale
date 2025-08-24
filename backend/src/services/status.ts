import { redis } from "./redis";

export async function getStatus() {
  const cfg = await redis.hgetall("sale:config");
  const stock = Number(await redis.get("sale:stock")) || 0;
  const startsAt = Number(cfg.startsAt);
  const endsAt = Number(cfg.endsAt);
  const now = Date.now();
  const sold = (Number(cfg.initialStock) || 0) - stock;
  const productId = cfg.productId;
  const productDescription = cfg.productDescription;

  let status: "upcoming" | "active" | "ended" | "sold_out" = "active";
  if (now < startsAt) status = "upcoming";
  else if (now > endsAt) status = "ended";
  else if (stock <= 0) status = "sold_out";

  return {
    status,
    startsAt,
    endsAt,
    stock,
    sold,
    productId,
    productDescription,
  };
}
