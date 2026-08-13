import type { Request, Response, NextFunction } from "express";

/**
 * Middleware that enforces INTERNAL_API_SECRET on sensitive internal routes.
 * The secret must be sent in the Authorization header as:
 *   Authorization: Bearer <secret>
 */
export function requireInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = process.env["INTERNAL_API_SECRET"];

  if (!secret) {
    // If no secret is configured, reject all internal requests
    res.status(503).json({ error: "Internal API not configured" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authorization header" });
    return;
  }

  const provided = authHeader.slice("Bearer ".length);
  if (provided !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}
