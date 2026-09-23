import type { Env } from "./types";

/**
 * Bearer-token gate for every /api/* route. Both sides are hashed first so the
 * comparison is fixed-length and constant-time regardless of what the caller sends.
 * With no TRACKER_TOKEN configured the answer is always "no" (fail closed).
 */
export async function isAuthorized(req: Request, env: Env): Promise<boolean> {
  const expected = env.TRACKER_TOKEN;
  if (!expected) return false;
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(m[1].trim())), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual(a, b);
}
