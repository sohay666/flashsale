export type SaleConfig = {
  productId: string;
  productDescription: string;
  startsAt: number;
  endsAt: number;
  initialStock: number;
};

// Read a non-empty string env or fallback
function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

// Read a number env or fallback (rejects NaN)
function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Parse a time env into epoch ms. Supports:
 * - epoch ms: "1724472000000"
 * - epoch seconds: "1724472000"
 * - ISO date: "2025-08-24T10:00:00+07:00"
 * - relative from now: "30s", "5m", "1h", "200ms" (prefixing + is optional)
 */
function envTime(name: string, fallbackMs: number, nowMs: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackMs;

  // all-digits → epoch seconds or ms
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    return num < 10_000_000_000 ? num * 1000 : num; // seconds → ms
  }

  // relative durations, e.g., "5m", "30s", "1h", "200ms"
  const rel = /^([+-]?\d+)\s*(ms|s|m|h)$/i.exec(raw);
  if (rel) {
    const val = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const factor =
      unit === "h"
        ? 3_600_000
        : unit === "m"
        ? 60_000
        : unit === "s"
        ? 1_000
        : 1;
    return nowMs + val * factor;
  }

  // ISO datetime
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return t;

  // fallback if unrecognized
  return fallbackMs;
}

export function loadSaleConfig(): SaleConfig {
  const now = Date.now();
  const startsAt = envTime("SALE_START", now + 60_000, now); // default +1min
  const endsAt = envTime("SALE_END", now + 3_600_000, now); // default +1h

  if (endsAt <= startsAt) {
    throw new Error("Invalid config: SALE_END must be after SALE_START.");
  }
  return {
    productId: envStr("PRODUCT_ID", "PRD-001"),
    productDescription: envStr(
      "PRODUCT_DESCRIPTION",
      "Ultra-rare drop. First come, first served. Limited stock."
    ),
    startsAt,
    endsAt,
    initialStock: envNum("SALE_STOCK", 1000),
  };
}
