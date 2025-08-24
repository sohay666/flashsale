import { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { assertCsrf, issueCsrfToken } from "./csrf";

/**
 * CSRF guard pre-handler.
 * - Verifies the double-submit CSRF (header vs cookie).
 * - On failure: rotates token (Set-Cookie + JSON) and ends the request with 403.
 * - On success: lets the request continue to the main handler.
 *
 * Reuse: add { preHandler: csrfPreHandler } on any state-changing route.
 */
export const csrfPreHandler: preHandlerHookHandler = async (
  req: FastifyRequest,
  rep: FastifyReply
) => {
  try {
    assertCsrf(req);
  } catch (e: any) {
    const payload = issueCsrfToken(req, rep); // rotate so SPA can recover
    return rep.code(403).send({
      error: "csrf",
      reason: e?.reason || "invalid",
      csrfToken: payload.csrfToken,
    });
  }
};
