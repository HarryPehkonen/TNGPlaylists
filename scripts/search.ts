#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env
/**
 * TNGPlaylists — semantic search test
 *
 * Embeds a natural-language query and finds the most similar episodes
 * via pgvector cosine similarity.
 *
 * Usage:
 *   EMBEDDINGS_BASE_URL=http://127.0.0.1:8645/v1 \
 *   DATABASE_URL=postgres://tng_user:PASS@localhost:5434/tngplaylists \
 *   deno run --allow-read --allow-write --allow-net --allow-env scripts/search.ts "query text"
 */

import { Client } from "jsr:@db/postgres";

const DB_URL = Deno.env.get("DATABASE_URL");
if (!DB_URL) { console.error("DATABASE_URL not set"); Deno.exit(1); }

const BASE_URL = Deno.env.get("EMBEDDINGS_BASE_URL") ?? "http://127.0.0.1:8645/v1";
const MODEL = Deno.env.get("EMBEDDINGS_MODEL") ?? "voyageai/voyage-4";
const API_KEY = Deno.env.get("EMBEDDINGS_API_KEY") ?? "proxy";

const query = Deno.args[0];
if (!query) { console.error("Usage: search.ts \"query text\""); Deno.exit(1); }

const pg = new Client(DB_URL);
await pg.connect();

// Embed the query
const resp = await fetch(`${BASE_URL}/embeddings`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
  body: JSON.stringify({ model: MODEL, input: query }),
});
if (!resp.ok) {
  console.error(`Embedding API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  Deno.exit(1);
}
const data = await resp.json();
const queryVec = data.data[0].embedding;
console.log(`Query embedded (${queryVec.length} dims): "${query}"\n`);

// Cosine similarity search via pgvector
const results = await pg.queryArray(
  `SELECT e.season, e.episode_number, e.title,
          1 - (ee.embedding <=> $1::vector) AS similarity,
          es.themes, left(es.moral_dilemma, 120) AS dilemma
     FROM episode_embeddings ee
     JOIN episodes e USING(episode_id)
     JOIN episode_summaries es USING(episode_id)
    ORDER BY ee.embedding <=> $1::vector
    LIMIT 10`,
  [`[${queryVec.join(",")}]`],
);

console.log("Top 10 matches:\n");
for (const [season, epNum, title, sim, themes, dilemma] of results.rows) {
  const pct = (Number(sim) * 100).toFixed(1);
  console.log(`  ${pct.padStart(5)}%  S${season}E${String(epNum).padStart(2, "0")}  ${title}`);
  console.log(`         themes: ${String(themes).slice(0, 100)}`);
  console.log(`         dilemma: ${String(dilemma).slice(0, 100)}`);
  console.log();
}

await pg.end();
