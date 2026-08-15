/**
 * TNGPlaylists — watched episodes routes
 *
 * Per-user watch tracking. NOT a global flag: every signed-in user has their
 * own list. Guests keep the same list in browser localStorage instead (see
 * web/app.js) — there is deliberately no merge between the two stores.
 *
 * All routes use requireAuth, not requireRole: watching episodes is a
 * personal action, so readers get server-side sync too.
 *
 * GET    /api/watched             — this user's watched episode ids
 * PUT    /api/watched/:episodeId  — mark watched (idempotent upsert)
 * DELETE /api/watched/:episodeId  — mark unwatched (idempotent)
 */

import { Router } from "jsr:@oak/oak";
import { queryObject } from "./db.ts";
import { requireAuth } from "./auth.ts";

export const watchedRouter = new Router();

// ---------------------------------------------------------------------------
// GET /api/watched
// ---------------------------------------------------------------------------

watchedRouter.get("/api/watched", requireAuth, async (ctx) => {
  const res = await queryObject(
    `SELECT episode_id FROM watched_episodes
      WHERE user_id = $1
      ORDER BY episode_id`,
    [ctx.state.user.user_id],
  );

  // Just the ids — the frontend holds them in a Set.
  ctx.response.body = {
    success: true,
    data: { watched: res.rows.map((r) => r.episode_id) },
  };
});

// ---------------------------------------------------------------------------
// PUT /api/watched/:episodeId — mark watched
// ---------------------------------------------------------------------------

watchedRouter.put("/api/watched/:episodeId", requireAuth, async (ctx) => {
  const episodeId = parseInt(ctx.params.episodeId ?? "", 10);
  if (!Number.isInteger(episodeId)) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Invalid episode id" };
    return;
  }

  // Idempotent: re-marking an already-watched episode just refreshes the time
  await queryObject(
    `INSERT INTO watched_episodes (user_id, episode_id) VALUES ($1, $2)
     ON CONFLICT (user_id, episode_id) DO UPDATE SET watched_at = now()`,
    [ctx.state.user.user_id, episodeId],
  );

  ctx.response.body = { success: true, data: { watched: true } };
});

// ---------------------------------------------------------------------------
// DELETE /api/watched/:episodeId — mark unwatched
// ---------------------------------------------------------------------------

watchedRouter.delete("/api/watched/:episodeId", requireAuth, async (ctx) => {
  const episodeId = parseInt(ctx.params.episodeId ?? "", 10);
  if (!Number.isInteger(episodeId)) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Invalid episode id" };
    return;
  }

  // Idempotent, like removing an episode from a playlist: no body, no 404 if
  // it was never watched.
  await queryObject(
    `DELETE FROM watched_episodes WHERE user_id = $1 AND episode_id = $2`,
    [ctx.state.user.user_id, episodeId],
  );

  ctx.response.status = 204;
  ctx.response.body = undefined;
});
