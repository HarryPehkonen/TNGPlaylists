/**
 * TNGPlaylists — keywords routes
 *
 * GET /api/keywords?category=place  — keywords in a category, alphabetical
 *                                     (used for the filter datalist)
 */

import { Router } from "jsr:@oak/oak";
import { queryObject } from "./db.ts";

export const keywordsRouter = new Router();

keywordsRouter.get("/api/keywords", async (ctx) => {
  const params = ctx.request.url.searchParams;
  const category = params.get("category")?.trim();

  const values: unknown[] = [];
  let whereSql = "";
  if (category) {
    whereSql = `WHERE c.category_key = $1`;
    values.push(category);
  }

  const res = await queryObject(
    `SELECT k.canonical, k.tier,
            COALESCE(array_agg(DISTINCT c.category_key)
               FILTER (WHERE c.category_key IS NOT NULL), '{}') AS categories
       FROM keywords k
       LEFT JOIN keyword_categories kcat ON kcat.keyword_id = k.keyword_id
       LEFT JOIN categories c ON c.category_id = kcat.category_id
       ${whereSql}
      GROUP BY k.keyword_id
      ORDER BY k.canonical`,
    values,
  );

  ctx.response.body = {
    success: true,
    data: {
      keywords: res.rows.map((r) => ({
        canonical: r.canonical,
        tier: r.tier,
        categories: r.categories,
      })),
      meta: { count: res.rows.length, category: category ?? null },
    },
  };
});
