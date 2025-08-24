import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { routes } from "./routes";
import { rateLimit } from "./middlewares/rateLimit";
import { redis, bootstrapSale, initTxPool } from "./services/redis";

const app = Fastify({ logger: true });

// Parse comma-separated list, support "*" wildcards
function parseAllowedOrigins(envVal: string | undefined, fallback: string[]) {
  const list = (envVal ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : fallback;
}

function toWildcardRegex(pattern: string): RegExp {
  // Escape regex specials, then turn "*" into ".*"
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

app.register(cors, {
  origin: (origin, cb) => {
    const DEFAULTS = ["http://localhost:5173", "http://127.0.0.1:5173"];
    const allowedPatterns = parseAllowedOrigins(
      process.env.ALLOWED_ORIGINS,
      DEFAULTS
    );
    const matchers = allowedPatterns.map(toWildcardRegex);

    // allow same-origin/no-Origin requests (like curl, server-to-server)
    if (!origin) return cb(null, true);

    // exact or wildcard match against the env list
    const ok = matchers.some((rx) => rx.test(origin));
    if (ok) return cb(null, true);
    cb(new Error("Not allowed by CORS"), false);
  },
  credentials: true, // <— THIS makes Fastify send Access-Control-Allow-Credentials: true
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-CSRF-Token", "Correlation-Id"],
});

app.register(cookie, {
  // set a signing secret if you want signed cookies
  // secret: process.env.COOKIE_SECRET || "dev-secret",
});

app.addHook("onRequest", rateLimit);
app.register(routes);

(async () => {
  await redis.flushall();
  await bootstrapSale();
  await initTxPool(); // init the TX connection pool once
  const port = Number(process.env.PORT || 4000);
  await app.listen({ port, host: "0.0.0.0" });
})();
