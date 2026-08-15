/**
 * TNGPlaylists — characters routes
 *
 * GET /api/characters           — list all characters (with optional total line counts)
 * GET /api/characters/:name     — character detail: episodes they appear in
 */

import { Router } from "jsr:@oak/oak";
import { queryObject } from "./db.ts";

export const charactersRouter = new Router();

// ---------------------------------------------------------------------------
// GET /api/characters — list with total line counts
// ---------------------------------------------------------------------------

charactersRouter.get("/api/characters", async (ctx) => {
  const params = ctx.request.url.searchParams;
  const q = params.get("q");
  const limit = Math.min(parseInt(params.get("limit") ?? "200", 10) || 200, 1000);
  const offset = parseInt(params.get("offset") ?? "0", 10) || 0;

  let whereSql = "";
  const values: unknown[] = [];
  if (q) {
    values.push(`%${q.toUpperCase()}%`);
    whereSql = "WHERE c.character_name LIKE $1";
  }

  const countRes = await queryObject(
    `SELECT COUNT(*)::int AS total FROM characters c ${whereSql}`,
    values,
  );
  const total = Number(countRes.rows[0]?.total ?? 0);

  const res = await queryObject(
    `SELECT c.character_id, c.character_name,
            COALESCE(SUM(lc.line_count), 0)::int AS total_lines,
            COUNT(lc.episode_id)::int AS episode_count
       FROM characters c
       LEFT JOIN line_counts lc ON lc.character_id = c.character_id
       ${whereSql}
      GROUP BY c.character_id
      ORDER BY total_lines DESC, c.character_name
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );

  ctx.response.body = {
    success: true,
    data: {
      characters: res.rows,
      meta: { total, limit, offset, returned: res.rows.length },
    },
  };
});

// ---------------------------------------------------------------------------
// GET /api/characters/:name — episodes for a character
// ---------------------------------------------------------------------------

charactersRouter.get("/api/characters/:name", async (ctx) => {
  const name = (ctx.params.name ?? "").toUpperCase().trim();

  const charRes = await queryObject(
    `SELECT character_id, character_name FROM characters WHERE character_name = $1`,
    [name],
  );
  if (charRes.rows.length === 0) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: `Character "${name}" not found` };
    return;
  }

  const episodesRes = await queryObject(
    `SELECT e.season, e.episode_number, e.episode_end, e.title,
            lc.line_count
       FROM line_counts lc
       JOIN episodes e ON e.episode_id = lc.episode_id
      WHERE lc.character_id = $1
      ORDER BY e.season, e.episode_number`,
    [charRes.rows[0].character_id],
  );

  ctx.response.body = {
    success: true,
    data: {
      ...charRes.rows[0],
      episodes: episodesRes.rows,
      total_lines: episodesRes.rows.reduce((sum, e) => sum + Number(e.line_count), 0),
      episode_count: episodesRes.rows.length,
    },
  };
});
