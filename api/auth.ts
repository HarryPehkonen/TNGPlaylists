/**
 * TNGPlaylists — authentication
 *
 * Google OAuth (own client, independent of the Notes app) + DB-backed
 * sessions. Roles: reader (default) < writer < admin.
 *
 * - GET  /api/auth/login    → redirect to Google OAuth
 * - GET  /api/auth/callback → exchange code, upsert user, set session cookie
 * - GET  /api/auth/me       → current user (or null)
 * - POST /api/auth/logout   → destroy session
 * - GET  /api/auth/users    → admin: list users
 * - POST /api/auth/users/:id/role → admin: set role
 *
 * Env:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
 *   ADMIN_EMAILS (comma-separated, first user with one of these → admin)
 */

import { Router } from "jsr:@oak/oak";
import { getCookies, setCookie, deleteCookie } from "jsr:@std/http@1/cookie";
import { queryObject } from "./db.ts";

export const authRouter = new Router();

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const SESSION_COOKIE = "tng_session";
const STATE_COOKIE = "tng_oauth_state";
const SESSION_DAYS = 30;

function getClientId(): string {
  const id = Deno.env.get("GOOGLE_CLIENT_ID");
  if (!id) throw new Error("GOOGLE_CLIENT_ID not set");
  return id;
}

function getClientSecret(): string {
  const secret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET not set");
  return secret;
}

function getRedirectUri(reqUrl: URL): string {
  const configured = Deno.env.get("GOOGLE_REDIRECT_URI");
  if (configured) return configured;
  // Default: same host as the request, so local dev works without config
  return `${reqUrl.protocol}//${reqUrl.host}/api/auth/callback`;
}

function getAdminEmails(): Set<string> {
  const raw = Deno.env.get("ADMIN_EMAILS") ?? "";
  return new Set(raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AuthUser {
  user_id: number;
  email: string;
  display_name: string | null;
  role: "reader" | "writer" | "admin";
}

/** Look up the current user from the session cookie, or null. */
export async function getCurrentUser(ctx: {
  request: { headers: Headers };
}): Promise<AuthUser | null> {
  const cookies = getCookies(ctx.request.headers);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const res = await queryObject(
    `SELECT u.user_id, u.email, u.display_name, u.role
       FROM sessions s
       JOIN users u ON u.user_id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0] as unknown as AuthUser;
}

/** Oak middleware: reject with 401 if not logged in, else attach user to ctx.state. */
export async function requireAuth(ctx: any, next: () => Promise<unknown>) {
  const user = await getCurrentUser(ctx);
  if (!user) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Login required" };
    return;
  }
  ctx.state.user = user;
  await next();
}

/** Oak middleware: reject with 403 unless the user has one of the given roles. */
export function requireRole(...roles: ("reader" | "writer" | "admin")[]) {
  return async (ctx: any, next: () => Promise<unknown>) => {
    const user = await getCurrentUser(ctx);
    if (!user) {
      ctx.response.status = 401;
      ctx.response.body = { success: false, error: "Login required" };
      return;
    }
    if (!roles.includes(user.role)) {
      ctx.response.status = 403;
      ctx.response.body = {
        success: false,
        error: roles.includes("admin")
          ? "Admin access required"
          : "Write access requires approval",
      };
      return;
    }
    ctx.state.user = user;
    await next();
  };
}

// ---------------------------------------------------------------------------
// GET /api/auth/login — kick off Google OAuth
// ---------------------------------------------------------------------------

authRouter.get("/api/auth/login", (ctx) => {
  const state = randomToken(16);
  const redirectUri = getRedirectUri(ctx.request.url);

  // State in a short-lived cookie, checked on callback (CSRF protection)
  setCookie(ctx.response.headers, {
    name: STATE_COOKIE,
    value: state,
    httpOnly: true,
    sameSite: "Lax",
    secure: ctx.request.url.protocol === "https:",
    maxAge: 600,
    path: "/",
  });

  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });

  ctx.response.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

// ---------------------------------------------------------------------------
// GET /api/auth/callback — exchange code, create session
// ---------------------------------------------------------------------------

authRouter.get("/api/auth/callback", async (ctx) => {
  const url = ctx.request.url;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = getCookies(ctx.request.headers);

  // Clear the state cookie regardless of outcome
  deleteCookie(ctx.response.headers, STATE_COOKIE, { path: "/" });

  if (!code || !state || state !== cookies[STATE_COOKIE]) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid OAuth state" };
    return;
  }

  const redirectUri = getRedirectUri(url);

  // Exchange code for tokens
  let tokenRes: Response;
  try {
    tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: getClientId(),
        client_secret: getClientSecret(),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
  } catch {
    ctx.response.status = 502;
    ctx.response.body = { success: false, error: "Token exchange failed" };
    return;
  }

  const tokenJson = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || !tokenJson?.access_token) {
    console.error("OAuth token exchange error:", tokenRes.status, JSON.stringify(tokenJson));
    ctx.response.status = 502;
    ctx.response.body = { success: false, error: "Token exchange failed" };
    return;
  }

  // Fetch profile
  const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  const profile = await userinfoRes.json().catch(() => null);
  if (!userinfoRes.ok || !profile?.email || !profile.email_verified) {
    ctx.response.status = 502;
    ctx.response.body = { success: false, error: "Could not verify Google account" };
    return;
  }

  const email = profile.email.toLowerCase();
  const isAdmin = getAdminEmails().has(email);

  // Upsert user (keyed on email — this is what links providers to one account)
  const userRes = await queryObject(
    `INSERT INTO users (email, display_name, picture, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       picture = COALESCE(EXCLUDED.picture, users.picture),
       last_login = now()
     RETURNING user_id, email, display_name, role`,
    [email, profile.name ?? null, profile.picture ?? null, isAdmin ? "admin" : "reader"],
  );
  const user = userRes.rows[0] as unknown as AuthUser;

  // Record provider link (Google today, Facebook tomorrow — same account)
  await queryObject(
    `INSERT INTO user_providers (user_id, provider, provider_sub)
     VALUES ($1, 'google', $2)
     ON CONFLICT (provider, provider_sub) DO NOTHING`,
    [user.user_id, String(profile.sub ?? "")],
  );

  // Create session
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await queryObject(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [tokenHash, user.user_id, expiresAt.toISOString()],
  );

  setCookie(ctx.response.headers, {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "Lax",
    secure: url.protocol === "https:",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
    path: "/",
  });

  ctx.response.redirect("/");
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

authRouter.get("/api/auth/me", async (ctx) => {
  const user = await getCurrentUser(ctx);
  ctx.response.body = { success: true, data: { user } };
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------

authRouter.post("/api/auth/logout", async (ctx) => {
  const cookies = getCookies(ctx.request.headers);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    const tokenHash = await sha256Hex(token);
    await queryObject(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
  }
  deleteCookie(ctx.response.headers, SESSION_COOKIE, { path: "/" });
  ctx.response.body = { success: true, data: null };
});

// ---------------------------------------------------------------------------
// Admin: user management
// ---------------------------------------------------------------------------

authRouter.get("/api/auth/users", requireRole("admin"), async (ctx) => {
  const res = await queryObject(
    `SELECT u.user_id, u.email, u.display_name, u.role, u.created_at, u.last_login,
            COUNT(s.token_hash)::int AS active_sessions
       FROM users u
       LEFT JOIN sessions s ON s.user_id = u.user_id AND s.expires_at > now()
      GROUP BY u.user_id
      ORDER BY u.created_at`,
  );
  ctx.response.body = { success: true, data: { users: res.rows } };
});

authRouter.post("/api/auth/users/:id/role", requireRole("admin"), async (ctx) => {
  const id = parseInt(ctx.params.id ?? "", 10);
  if (!Number.isInteger(id)) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid user id" };
    return;
  }

  const body = await ctx.request.body.json().catch(() => null);
  const role = body?.role;
  if (!["reader", "writer", "admin"].includes(role)) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "role must be reader, writer, or admin" };
    return;
  }

  const res = await queryObject(
    `UPDATE users SET role = $1 WHERE user_id = $2
     RETURNING user_id, email, role`,
    [role, id],
  );
  if (res.rows.length === 0) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }
  ctx.response.body = { success: true, data: res.rows[0] };
});
