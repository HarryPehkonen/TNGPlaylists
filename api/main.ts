/**
 * TNGPlaylists — API server
 *
 * Oak-based API for the TNG episode database. Follows the Notes app
 * conventions: {"success": true, "data": {...}} response envelope,
 * env-var config, no build step.
 *
 * Run:
 *   DATABASE_URL=postgres://tng_user:PASS@localhost:5434/tngplaylists \
 *   deno run --allow-net --allow-read --allow-env api/main.ts
 */

import { Application, send } from "jsr:@oak/oak";
import { episodesRouter } from "./episodes.ts";
import { charactersRouter } from "./characters.ts";
import { searchRouter } from "./search.ts";
import { playlistsRouter } from "./playlists.ts";
import { authRouter } from "./auth.ts";
import { getClient } from "./db.ts";

const PORT = parseInt(Deno.env.get("PORT") ?? "8090", 10);
const HOST = Deno.env.get("HOST") ?? "127.0.0.1";
const WEB_DIR = Deno.env.get("WEB_DIR") ??
  new URL("../web/", import.meta.url).pathname;

const app = new Application();

// Logging middleware
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`${ctx.request.method} ${ctx.request.url.pathname} — ${ctx.response.status} (${ms}ms)`);
});

// CORS — allow only same-origin (frontend is served from this same origin).
app.use(async (ctx, next) => {
  const origin = ctx.request.headers.get("origin");
  if (origin) {
    const host = ctx.request.headers.get("host");
    const allowed = origin === `https://${host}` || origin === `http://${host}`;
    if (allowed) {
      ctx.response.headers.set("Access-Control-Allow-Origin", origin);
      ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
  }
  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 204;
    return;
  }
  await next();
});

// Error handling
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error("Unhandled error:", err);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Internal server error" };
  }
});

// Health check
app.use(async (ctx, next) => {
  if (ctx.request.url.pathname === "/api/health") {
    try {
      await (await getClient()).queryArray("SELECT 1");
      ctx.response.body = { success: true, data: { status: "ok", db: "connected" } };
    } catch {
      ctx.response.status = 503;
      ctx.response.body = { success: false, error: "db unavailable" };
    }
    return;
  }
  await next();
});

// Routes
app.use(authRouter.routes());
app.use(authRouter.allowedMethods());
app.use(episodesRouter.routes());
app.use(episodesRouter.allowedMethods());
app.use(charactersRouter.routes());
app.use(charactersRouter.allowedMethods());
app.use(searchRouter.routes());
app.use(searchRouter.allowedMethods());
app.use(playlistsRouter.routes());
app.use(playlistsRouter.allowedMethods());

// Static files (web frontend)
app.use(async (ctx, next) => {
  if (ctx.request.url.pathname.startsWith("/api/")) {
    await next();
    return;
  }

  const path = ctx.request.url.pathname === "/" ? "index.html" : ctx.request.url.pathname;

  try {
    await send(ctx, path, { root: WEB_DIR });
  } catch {
    // File not found — fall through to 404
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Not found" };
  }
});

// 404
app.use((ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { success: false, error: "Not found" };
});

console.log(`TNGPlaylists API listening on http://${HOST}:${PORT}`);
await app.listen({ hostname: HOST, port: PORT });
