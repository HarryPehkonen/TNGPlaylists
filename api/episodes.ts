/**
 * TNGPlaylists — episode routes
 *
 * GET  /api/episodes           — list episodes (filters: season, character, keyword, category, writer, director)
 * GET  /api/episodes/:id       — episode detail (characters, keywords, credits, summary)
 * GET  /api/episodes/:id/summary — episode summary JSON
 */

import { Router } from "jsr:@oak/oak";
import { queryArray, queryObject } from "./db.ts";

export const episodesRouter = new Router();

// ---------------------------------------------------------------------------
// GET /api/episodes — list with optional filters
// ---------------------------------------------------------------------------

episodesRouter.get("/api/episodes", async (ctx) => {
  const params = ctx.request.url.searchParams;

  const season = params.get("season");
  const character = params.get("character");
  const keyword = params.get("keyword");
  const category = params.get("category");
  const writer = params.get("writer");
  const director = params.get("director");
  const q = params.get("q");
  const limit = Math.min(parseInt(params.get("limit") ?? "100", 10) || 100, 500);
  const offset = parseInt(params.get("offset") ?? "0", 10) || 0;

  // Build WHERE clauses and join conditions
  const wheres: string[] = [];
  const joins: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;
  let selectExtra = "";
  let orderBy = "e.season, e.episode_number";

  if (season) {
    wheres.push(`e.season = $${paramIdx++}`);
    values.push(parseInt(season, 10));
  }

  if (character) {
    joins.push(`JOIN line_counts lc ON lc.episode_id = e.episode_id`);
    joins.push(`JOIN characters ch ON ch.character_id = lc.character_id`);
    wheres.push(`ch.character_name = $${paramIdx++}`);
    values.push(character.toUpperCase());
    // Show the character's line count and sort episodes by it (most lines first)
    selectExtra = `, lc.line_count AS character_lines`;
    orderBy = `character_lines DESC, e.season, e.episode_number`;
  }

  if (keyword) {
    joins.push(`JOIN keyword_counts kc ON kc.episode_id = e.episode_id`);
    joins.push(`JOIN keywords kw ON kw.keyword_id = kc.keyword_id`);
    wheres.push(`kw.canonical = $${paramIdx++}`);
    values.push(keyword);
  }

  if (category) {
    joins.push(`JOIN keyword_counts kc2 ON kc2.episode_id = e.episode_id`);
    joins.push(`JOIN keyword_categories kcat2 ON kcat2.keyword_id = kc2.keyword_id`);
    joins.push(`JOIN categories cat2 ON cat2.category_id = kcat2.category_id`);
    wheres.push(`cat2.category_key = $${paramIdx++}`);
    values.push(category);
  }

  if (writer || director) {
    joins.push(`JOIN credits cr ON cr.episode_id = e.episode_id`);
    joins.push(`JOIN people p ON p.person_id = cr.person_id`);
    if (writer) {
      wheres.push(`cr.role != 'director' AND p.name = $${paramIdx++}`);
      values.push(writer);
    }
    if (director) {
      wheres.push(`cr.role = 'director' AND p.name = $${paramIdx++}`);
      values.push(director);
    }
  }

  if (q) {
    // Simple ILIKE over title and site_transcript_id
    wheres.push(`(e.title ILIKE $${paramIdx++} OR e.title ILIKE $${paramIdx})`);
    values.push(`%${q}%`, `%${q}%`);
    paramIdx += 1;
  }

  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const joinSql = joins.join("\n");

  const countSql = `
    SELECT COUNT(DISTINCT e.episode_id)::int AS total
      FROM episodes e
      ${joinSql}
      ${whereSql}
  `;
  const countRes = await queryObject(countSql, values);
  const total = Number(countRes.rows[0]?.total ?? 0);

  const dataSql = `
    SELECT DISTINCT e.episode_id, e.season, e.episode_number, e.episode_end,
           e.title, e.site_transcript_id, e.original_air_date, e.us_viewers_millions
           ${selectExtra}
      FROM episodes e
      ${joinSql}
      ${whereSql}
     ORDER BY ${orderBy}
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `;
  const dataRes = await queryObject(dataSql, [...values, limit, offset]);

  ctx.response.body = {
    success: true,
    data: {
      episodes: dataRes.rows,
      meta: { total, limit, offset, returned: dataRes.rows.length },
    },
  };
});

// ---------------------------------------------------------------------------
// GET /api/episodes/:id — full detail
// ---------------------------------------------------------------------------

episodesRouter.get("/api/episodes/:id", async (ctx) => {
  const id = parseInt(ctx.params.id ?? "", 10);
  if (!Number.isInteger(id)) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid episode id" };
    return;
  }

  const epRes = await queryObject(
    `SELECT e.* FROM episodes e WHERE e.episode_id = $1`,
    [id],
  );
  if (epRes.rows.length === 0) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Episode not found" };
    return;
  }
  const episode = epRes.rows[0];

  // Characters with line counts
  const charsRes = await queryObject(
    `SELECT c.character_name, lc.line_count
       FROM line_counts lc
       JOIN characters c ON c.character_id = lc.character_id
      WHERE lc.episode_id = $1
      ORDER BY lc.line_count DESC`,
    [id],
  );

  // Keywords with categories
  const kwRes = await queryObject(
    `SELECT k.canonical, k.tier, kc.occurrences,
            COALESCE(array_agg(DISTINCT cat.category_key) FILTER (WHERE cat.category_key IS NOT NULL), '{}') AS categories
       FROM keyword_counts kc
       JOIN keywords k ON k.keyword_id = kc.keyword_id
       LEFT JOIN keyword_categories kcat ON kcat.keyword_id = k.keyword_id
       LEFT JOIN categories cat ON cat.category_id = kcat.category_id
      WHERE kc.episode_id = $1
      GROUP BY k.keyword_id, kc.occurrences
      ORDER BY kc.occurrences DESC`,
    [id],
  );

  // Credits
  const creditsRes = await queryObject(
    `SELECT p.name, c.role
       FROM credits c
       JOIN people p ON p.person_id = c.person_id
      WHERE c.episode_id = $1
      ORDER BY c.role, p.name`,
    [id],
  );

  // Summary (if exists)
  const summaryRes = await queryObject(
    `SELECT characters, places, themes, key_events, species, technology,
            moral_dilemma, source_file, generated_at
       FROM episode_summaries WHERE episode_id = $1`,
    [id],
  );

  ctx.response.body = {
    success: true,
    data: {
      ...episode,
      characters: charsRes.rows,
      keywords: kwRes.rows,
      credits: creditsRes.rows,
      summary: summaryRes.rows[0] ?? null,
    },
  };
});

// ---------------------------------------------------------------------------
// GET /api/episodes/:id/summary — just the summary
// ---------------------------------------------------------------------------

episodesRouter.get("/api/episodes/:id/summary", async (ctx) => {
  const id = parseInt(ctx.params.id ?? "", 10);
  if (!Number.isInteger(id)) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid episode id" };
    return;
  }

  const res = await queryObject(
    `SELECT characters, places, themes, key_events, species, technology,
            moral_dilemma, source_file, generated_at
       FROM episode_summaries WHERE episode_id = $1`,
    [id],
  );
  if (res.rows.length === 0) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "No summary for this episode" };
    return;
  }

  ctx.response.body = { success: true, data: res.rows[0] };
});
