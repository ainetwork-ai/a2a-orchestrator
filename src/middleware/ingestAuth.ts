import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";

/**
 * EPIC8: Bearer-token gate for the ainspace dual-write ingest endpoint.
 *
 * The live orchestration routes are unauthenticated (CORS only), but ingest is
 * a WRITE path that only the ainspace frontend (BFF) may call. That "only
 * ainspace calls it" property is the basis of the "orchestrator == ainspace
 * conversations" provenance invariant, so we gate it with a shared secret.
 *
 * Fail closed: if INGEST_TOKEN is unset the endpoint is DISABLED (503) rather
 * than open, so a misconfigured deploy never accepts unauthenticated writes.
 */
export function ingestAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.INGEST_TOKEN;

  if (!expected) {
    res.status(503).json({
      error: "Ingest endpoint disabled: INGEST_TOKEN is not configured",
    });
    return;
  }

  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();

  if (!token || !safeEqual(token, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

/** Constant-time string comparison (avoids leaking the token via timing). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
