import { FastifyInstance } from "fastify";
import { getStatus } from "./services/status";
import { getPurchase, doPurchase } from "./services/purchase";
import { issueCsrfToken } from "./security/csrf";
import { csrfPreHandler } from "./security/csrf-guard";

export async function routes(app: FastifyInstance) {
  app.get("/api/status", getStatus);

  // CSRF token endpoint
  app.get("/api/csrf", async (req, rep) => {
    return issueCsrfToken(req, rep);
  });

  app.get("/api/purchase/:userId", getPurchase);
  app.post("/api/purchase", { preHandler: csrfPreHandler }, doPurchase);
}
