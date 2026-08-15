/**
 * TNGPlaylists — playlists routes
 *
 * GET    /api/playlists          — list playlists (with episode counts)
 * POST   /api/playlists          — create playlist {name, description, is_smart, criteria}
 * GET    /api/playlists/:id      — playlist detail (with episodes)
 * PUT    /api/playlists/:id      — update playlist
 * DELETE /api/playlists/:id      — delete playlist
 * POST   /api/playlists/:id/episodes — add episode {episode_id, position?}
 * DELETE /api/playlists/:id/episodes/:episodeId — remove episode
 */

import { Router } from "jsr:@oak/oak";
import { queryObject } from "./db.ts";
import { requireRole } from "./auth.ts";

export const playlistsRouter = new Router();

// ---------------------------------------------------------------------------
// GET /api/playlists
// ---------------------------------------------------------------------------

playlistsRouter.get("/api/playlists", async (ctx) => {
  const res = await queryObject(
    `SELECT p.playlist_id, p.name, p.description, p.is_smart, p.criteria,
            p.created_at, p.updated_at,
            COUNT(pe.episode_id)::int AS episode_count
       FROM playlists p
       LEFT JOIN playlist_episodes pe ON pe.playlist_id = p.playlist_id
      GROUP BY p.playlist_id
      ORDER BY p.name`,
  );

  ctx.response.body = { success: true, data: { playlists: res.rows } };
});

// ---------------------------------------------------------------------------
// POST /api/playlists
// ---------------------------------------------------------------------------

playlistsRouter.post("/api/playlists", requireRole("writer", "admin"), async (ctx) => {
  const body = await ctx.request.body.json().catch(() => null);
  if (!body?.name || typeof body.name !== "string") {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "name is required" };
    return;
  }

  const res = await queryObject(
    `INSERT INTO playlists (name, description, is_smart, criteria)
     VALUES ($1, $2, $3, $4)
     RETURNING playlist_id, name, description, is_smart, criteria, created_at, updated_at`,
    [
      body.name,
      typeof body.description === "string" ? body.description : "",
      Boolean(body.is_smart),
      body.criteria ? JSON.stringify(body.criteria) : null,
    ],
  );

  ctx.response.status = 201;
  ctx.response.body = { success: true, data: res.rows[0] };
});

// ---------------------------------------------------------------------------
// GET /api/playlists/:id
// ---------------------------------------------------------------------------

playlistsRouter.get("/api/playlists/:id", async (ctx) => {
  const id = parseInt(ctx.params.id ?? "", 10);
  if (!Number.isInteger(id)) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid playlist id" };
    return;
  }

  const plRes = await queryObject(
    `SELECT playlist_id, name, description, is_smart, criteria, created_at, updated_at
       FROM playlists WHERE playlist_id = $1`,
    [id],
  );
  if (plRes.rows.length === 0) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Playlist not found" };
    return;
  }

  const epsRes = await queryObject(
    `SELECT e.episode_id, e.season, e.episode_number, e.title,
            e.site_transcript_id, pe.position
       FROM playlist_episodes pe
       JOIN episodes e ON e.episode_id = pe.episode_id
      WHERE pe.playlist_id = $1
      ORDER BY pe.position, e.season, e.episode_number`,
    [id],
  );

  ctx.response.body = {
    success: true,
    data: { ...plRes.rows[0], episodes: epsRes.rows },
  };
});

// ---------------------------------------------------------------------------
// PUT /api/playlists/:id
// ---------------------------------------------------------------------------

playlistsRouter.put("/api/playlists/:id", requireRole("writer", "admin"), async (ctx) => {
  const id = parseInt(ctx.params.id ?? "", 10);
  if (!Number.isInteger(id)) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid playlist id" };
    return;
  }

  const body = await ctx.request.body.json().catch(() => null);
  if (!body) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid body" };
    return;
  }

  const res = await queryObject(
    `UPDATE playlists SET
       name = COALESCE($1, name),
       description = COALESCE($2, description),
       is_smart = COALESCE($3, is_smart),
       criteria = COALESCE($4, criteria),
       updated_at = now()
     WHERE playlist_id = $5
     RETURNING playlist_id, name, description, is_smart, criteria, created_at, updated_at`,
    [
      typeof body.name === "string" ? body.name : null,
      typeof body.description === "string" ? body.description : null,
      typeof body.is_smart === "boolean" ? body.is_smart : null,
      body.criteria ? JSON.stringify(body.criteria) : null,
      id,
    ],
  );

  if (res.rows.length === 0) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Playlist not found" };
    return;
  }
  ctx.response.body = { success: true, data: res.rows[0] };
});

// ---------------------------------------------------------------------------
// DELETE /api/playlists/:id
// ---------------------------------------------------------------------------

playlistsRouter.delete("/api/playlists/:id", requireRole("writer", "admin"), async (ctx) => {
  const id = parseInt(ctx.params.id ?? "", 10);
  if (!Number.isInteger(id)) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid playlist id" };
    return;
  }

  const res = await queryObject(
    `DELETE FROM playlists WHERE playlist_id = $1 RETURNING playlist_id`,
    [id],
  );
  if (res.rows.length === 0) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Playlist not found" };
    return;
  }
  ctx.response.status = 204;
  ctx.response.body = undefined;
});

// ---------------------------------------------------------------------------
// POST /api/playlists/:id/episodes — add episode
// ---------------------------------------------------------------------------

playlistsRouter.post("/api/playlists/:id/episodes", requireRole("writer", "admin"), async (ctx) => {
  const id = parseInt(ctx.params.id ?? "", 10);
  if (!Number.isInteger(id)) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid playlist id" };
    return;
  }

  const body = await ctx.request.body.json().catch(() => null);
  if (!body?.episode_id) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "episode_id is required" };
    return;
  }

  // Position: append to end unless specified
  const posRes = await queryObject(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM playlist_episodes WHERE playlist_id = $1`,
    [id],
  );
  const position = Number(body.position ?? posRes.rows[0]?.next_pos ?? 0);

  const res = await queryObject(
    `INSERT INTO playlist_episodes (playlist_id, episode_id, position)
     VALUES ($1, $2, $3)
     ON CONFLICT (playlist_id, episode_id) DO UPDATE SET position = EXCLUDED.position
     RETURNING playlist_id, episode_id, position`,
    [id, body.episode_id, position],
  );

  ctx.response.status = 201;
  ctx.response.body = { success: true, data: res.rows[0] };
});

// ---------------------------------------------------------------------------
// DELETE /api/playlists/:id/episodes/:episodeId
// ---------------------------------------------------------------------------

playlistsRouter.delete("/api/playlists/:id/episodes/:episodeId", requireRole("writer", "admin"), async (ctx) => {
  const id = parseInt(ctx.params.id ?? "", 10);
  const episodeId = parseInt(ctx.params.episodeId ?? "", 10);
  if (!Number.isInteger(id) || !Number.isInteger(episodeId)) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid ids" };
    return;
  }

  const res = await queryObject(
    `DELETE FROM playlist_episodes WHERE playlist_id = $1 AND episode_id = $2
     RETURNING playlist_id, episode_id`,
    [id, episodeId],
  );
  if (res.rows.length === 0) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Episode not in playlist" };
    return;
  }
  ctx.response.status = 204;
  ctx.response.body = undefined;
});
