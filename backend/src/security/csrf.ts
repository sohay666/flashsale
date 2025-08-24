import { FastifyReply, FastifyRequest } from "fastify";

const CSRF_COOKIE = "csrfToken";

// Issue a random CSRF token and set it as a cookie.
// Return it in the body so the SPA can read it and send back in a header.
export function issueCsrfToken(req: FastifyRequest, rep: FastifyReply) {
  const token = cryptoRandom();
  rep.setCookie(CSRF_COOKIE, token, {
    httpOnly: false, // must be readable by SPA to send header (double-submit pattern)
    sameSite: "lax",
    secure: false, // set true in HTTPS/prod
    path: "/",
    maxAge: 60 * 60, // 1 hour
  });
  return { csrfToken: token };
}

// Validate CSRF for state-changing requests
export function assertCsrf(req: FastifyRequest) {
  const header = (req.headers["x-csrf-token"] ||
    req.headers["x-xsrf-token"]) as string | undefined;
  const cookie = (req as any).cookies?.[CSRF_COOKIE] as string | undefined;
  if (!cookie) {
    const e: any = new Error("Missing CSRF cookie");
    e.statusCode = 403;
    e.reason = "missing_cookie";
    throw e;
  }
  if (!header) {
    const e: any = new Error("Missing CSRF header");
    e.statusCode = 403;
    e.reason = "missing_header";
    throw e;
  }
  if (header !== cookie) {
    const e: any = new Error("CSRF token mismatch");
    e.statusCode = 403;
    e.reason = "mismatch";
    throw e;
  }
}

function cryptoRandom() {
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(32));
  if (bytes) return toBase64Url(bytes);
  const { randomBytes } = require("node:crypto");
  return randomBytes(32).toString("base64url");
}

function toBase64Url(bytes: Uint8Array | Buffer): string {
  // Node path
  if (typeof Buffer !== "undefined") {
    const b64 = Buffer.from(bytes as any).toString("base64");
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  // Browser fallback
  const arr = bytes as Uint8Array;
  let binary = "";
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
