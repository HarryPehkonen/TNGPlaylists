/**
 * TNGPlaylists — search routes
 *
 * GET /api/search?q=...            — hybrid search
 *   - structured: keyword, character, category, writer, director filters
 *   - semantic:   free-text query embedded via voyageai, pgvector cosine search
 *
 * Parameters:
 *   q          — free-text query (semantic search over summaries)
 *   keyword    — exact keyword term
 *   character  — character name
 *   category   — keyword category (place, race, faction, technology, ...)
 *   writer     — writer name
 *   director   — director name
 *   season     — season number
 *   limit      — max results (default 20)
 *
 * Structured filters combine with AND; if q is present it ranks the
 * filtered set semantically (when embeddings exist) or falls back to ILIKE.
 */

import { Router } from "jsr:@oak/oak";
import { queryArray, queryObject } from "./db.ts";

export const searchRouter = new Router();

const EMBEDDINGS_BASE_URL = Deno.env.get("EMBEDDINGS_BASE_URL") ??
  "http://127.0.0.1:8645/v1";
const EMBEDDINGS_MODEL = Deno.env.get("EMBEDDINGS_MODEL") ?? "voyageai/voyage-4";
const EMBEDDINGS_API_KEY = Deno.env.get("EMBEDDINGS_API_KEY") ?? "proxy";

async function embed(text: string): Promise<number[]> {
  const resp = await fetch(`${EMBEDDINGS_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${EMBEDDINGS_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDINGS_MODEL, input: text }),
  });
  if (!resp.ok) {
    throw new Error(`Embedding API ${resp.status}`);
  }
  const data = await resp.json();
  return data.data?.[0]?.embedding;
}

// ---------------------------------------------------------------------------
// GET /api/search
// ---------------------------------------------------------------------------

searchRouter.get("/api/search", async (ctx) => {
  const params = ctx.request.url.searchParams;
  const q = params.get("q");
  const keyword = params.get("keyword");
  const character = params.get("character");
  const category = params.get("category");
  const writer = params.get("writer");
  const director = params.get("director");
  const season = params.get("season");
  const limit = Math.min(parseInt(params.get("limit") ?? "20", 10) || 20, 100);

  // ------------------------------------------------------------------
  // Build structured filter (WHERE on episodes)
  // ------------------------------------------------------------------
  const wheres: string[] = [];
  const joins: string[] = [];
  const values: unknown[] = [];
  let p = 1;

  if (season) {
    wheres.push(`e.season = $${p++}`);
    values.push(parseInt(season, 10));
  }
  if (keyword) {
    joins.push(`JOIN keyword_counts kc ON kc.episode_id = e.episode_id`);
    joins.push(`JOIN keywords kw ON kw.keyword_id = kc.keyword_id`);
    wheres.push(`kw.canonical = $${p++}`);
    values.push(keyword);
  }
  if (character) {
    joins.push(`JOIN line_counts lc ON lc.episode_id = e.episode_id`);
    joins.push(`JOIN characters ch ON ch.character_id = lc.character_id`);
    wheres.push(`ch.character_name = $${p++}`);
    values.push(character.toUpperCase());
  }
  if (category) {
    joins.push(`JOIN keyword_counts kc2 ON kc2.episode_id = e.episode_id`);
    joins.push(`JOIN keyword_categories kcat2 ON kcat2.keyword_id = kc2.keyword_id`);
    joins.push(`JOIN categories cat2 ON cat2.category_id = kcat2.category_id`);
    wheres.push(`cat2.category_key = $${p++}`);
    values.push(category);
  }
  if (writer || director) {
    joins.push(`JOIN credits cr ON cr.episode_id = e.episode_id`);
    joins.push(`JOIN people pp ON pp.person_id = cr.person_id`);
    if (writer) {
      wheres.push(`cr.role != 'director' AND pp.name = $${p++}`);
      values.push(writer);
    }
    if (director) {
      wheres.push(`cr.role = 'director' AND pp.name = $${p++}`);
      values.push(director);
    }
  }

  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const joinSql = joins.join("\n");

  const baseSelect = `
    SELECT DISTINCT e.episode_id, e.season, e.episode_number, e.title,
           e.site_transcript_id, e.original_air_date
      FROM episodes e
      ${joinSql}
      ${whereSql}
  `;

  // ------------------------------------------------------------------
  // Semantic ranking when q is present
  // ------------------------------------------------------------------
  if (q) {
    let queryVec: number[] | null = null;
    try {
      queryVec = await embed(q);
    } catch {
      queryVec = null;
    }

    if (queryVec) {
      // Semantic: rank filtered episodes by cosine similarity.
      // Use the filtered episode set as a CTE, then join embeddings.
      const sql = `
        WITH filtered AS (
          ${baseSelect}
        )
        SELECT f.season, f.episode_number, f.title, f.site_transcript_id,
               f.original_air_date,
               1 - (ee.embedding <=> $${p}::vector) AS similarity
          FROM filtered f
          JOIN episode_embeddings ee ON ee.episode_id = f.episode_id
         ORDER BY similarity DESC
         LIMIT $${p + 1}
      `;
      const res = await queryObject(sql, [...values, `[${queryVec.join(",")}]`, limit]);
      ctx.response.body = {
        success: true,
        data: {
          mode: "semantic",
          query: q,
          results: res.rows,
          meta: { count: res.rows.length, limit },
        },
      };
      return;
    }

    // Fallback: ILIKE over title + summary text
    const sql = `
      WITH filtered AS (
        ${baseSelect}
      )
      SELECT f.season, f.episode_number, f.title, f.site_transcript_id,
             f.original_air_date
        FROM filtered f
        LEFT JOIN episode_summaries es ON es.episode_id = f.episode_id
       WHERE f.title ILIKE $${p}
          OR es.moral_dilemma ILIKE $${p}
          OR es.themes::text ILIKE $${p}
       ORDER BY f.season, f.episode_number
       LIMIT $${p + 1}
    `;
    const res = await queryObject(sql, [...values, `%${q}%`, limit]);
    ctx.response.body = {
      success: true,
      data: {
        mode: "text-fallback",
        query: q,
        results: res.rows,
        meta: { count: res.rows.length, limit },
      },
    };
    return;
  }

  // ------------------------------------------------------------------
  // Structured-only search
  // ------------------------------------------------------------------
  const res = await queryObject(
    `${baseSelect} ORDER BY e.season, e.episode_number LIMIT $${p++} OFFSET $${p++}`,
    [...values, limit, 0],
  );

  ctx.response.body = {
    success: true,
    data: {
      mode: "structured",
      results: res.rows,
      meta: { count: res.rows.length, limit },
    },
  };
});
