import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { DashboardLoginBody } from "@workspace/api-zod";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

const COOKIE_NAME = "dash_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Derive the expected cookie value from the SESSION_SECRET so it can't be forged. */
function makeSessionToken(): string {
  const secret = process.env["SESSION_SECRET"];
  if (!secret) {
    throw new Error("SESSION_SECRET env var is required for dashboard session signing");
  }
  return crypto.createHmac("sha256", secret).update("dash:authenticated").digest("hex");
}

/** Middleware: require dashboard session. Sends 401 if not authenticated. */
export function requireDashboardAuth(req: Request, res: Response, next: () => void): void {
  const token = (req as Request & { signedCookies: Record<string, string> }).signedCookies[COOKIE_NAME];
  if (!token || token !== makeSessionToken()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// POST /dashboard/auth/login
router.post("/dashboard/auth/login", async (req, res): Promise<void> => {
  const parsed = DashboardLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const secret = process.env["DASHBOARD_SECRET"];
  if (!secret) {
    logger.warn("DASHBOARD_SECRET not set — dashboard login is disabled");
    res.status(401).json({ error: "Dashboard login not configured" });
    return;
  }

  if (parsed.data.password !== secret) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  const token = makeSessionToken();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
    signed: true,
  });

  res.json({ authenticated: true });
});

// POST /dashboard/auth/logout
router.post("/dashboard/auth/logout", (_req, res): void => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// GET /dashboard/auth/me
router.get("/dashboard/auth/me", (req, res): void => {
  const token = (req as Request & { signedCookies: Record<string, string> }).signedCookies[COOKIE_NAME];
  const authenticated = !!(token && token === makeSessionToken());
  res.json({ authenticated });
});

export default router;
