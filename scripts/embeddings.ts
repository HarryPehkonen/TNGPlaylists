#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env
/**
 * TNGPlaylists — embedding generator
 *
 * Generates vector embeddings for episode summaries using the Hermes proxy
 * (voyageai/voyage-4 embedding model) and stores them in the
 * episode_embeddings table for semantic search with pgvector.
 *
 * Usage:
 *   EMBEDDINGS_BASE_URL=http://127.0.0.1:8645/v1 \
 *   DATABASE_URL=postgres://tng_user:PASS@localhost:5434/tngplaylists \
 *   deno run --allow-read --allow-write --allow-net --allow-env scripts/embeddings.ts
 */

import { Client } from "jsr:@db/postgres";

const DB_URL = Deno.env.get("DATABASE_URL");
if (!DB_URL) {
  console.error("DATABASE_URL not set");
  Deno.exit(1);
}

const BASE_URL = Deno.env.get("EMBEDDINGS_BASE_URL") ?? "http://127.0.0.1:8645/v1";
const MODEL = Deno.env.get("EMBEDDINGS_MODEL") ?? "voyageai/voyage-4";
const API_KEY = Deno.env.get("EMBEDDINGS_API_KEY") ?? "proxy";

const pg = new Client(DB_URL);
await pg.connect();

console.log(`✓ Connected to Postgres`);
console.log(`✓ Embedding model: ${MODEL}`);

// ---------------------------------------------------------------------------
// Build one text blob per episode from the summary fields
// ---------------------------------------------------------------------------

const episodes = await pg.queryArray(`
  SELECT es.episode_id,
         e.season, e.episode_number, e.title,
         es.characters, es.places, es.themes, es.key_events,
         es.species, es.technology, es.moral_dilemma
    FROM episode_summaries es
    JOIN episodes e USING(episode_id)
   ORDER BY e.season, e.episode_number
`);

console.log(`✓ Found ${episodes.rows.length} episodes with summaries`);

function episodeToText(row: (string | number | null)[]): string {
  const [, season, epNum, title, characters, places, themes, keyEvents, species, tech, dilemma] = row;

  const parse = (v: unknown): unknown[] => {
    if (typeof v !== "string") return [];
    try { return JSON.parse(v); } catch { return []; }
  };

  const charList = (parse(characters) as Record<string, unknown>[])
    .map((c) => `${c.name ?? ""} (${c.role ?? ""}): ${c.actions ?? ""}`)
    .join("\n");

  const eventList = (parse(keyEvents) as Record<string, unknown>[])
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
    .map((e) => String(e.event ?? ""))
    .join("\n");

  return [
    `Title: ${title} (Season ${season}, Episode ${epNum})`,
    "",
    "Characters:",
    charList,
    "",
    `Places: ${(parse(places) as string[]).join(", ")}`,
    `Species: ${(parse(species) as string[]).join(", ")}`,
    `Technology: ${(parse(tech) as string[]).join(", ")}`,
    "",
    "Themes:",
    (parse(themes) as string[]).join("\n"),
    "",
    "Key events:",
    eventList,
    "",
    "Moral dilemma:",
    String(dilemma ?? ""),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Generate embeddings via the Hermes proxy
// ---------------------------------------------------------------------------

interface EmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[];
  error?: { message?: string };
}

async function embed(text: string): Promise<number[]> {
  const resp = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: text,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Embedding API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as EmbeddingResponse;
  if (data.error) throw new Error(`Embedding error: ${data.error.message}`);
  const emb = data.data?.[0]?.embedding;
  if (!emb) throw new Error("No embedding in response");
  return emb;
}

// ---------------------------------------------------------------------------
// Store embeddings (batch of 5 at a time; voyageai is fine with batching)
// ---------------------------------------------------------------------------

const batchSize = 5;
let done = 0;
let skipped = 0;

for (let i = 0; i < episodes.rows.length; i += batchSize) {
  const batch = episodes.rows.slice(i, i + batchSize);

  for (const row of batch) {
    const epId = row[0] as number;
    const text = episodeToText(row);

    // Skip episodes already embedded
    const existing = await pg.queryArray(
      "SELECT 1 FROM episode_embeddings WHERE episode_id = $1",
      [epId],
    );
    if (existing.rows.length > 0) {
      skipped++;
      continue;
    }

    try {
      const embedding = await embed(text);
      await pg.queryArray(
        `INSERT INTO episode_embeddings (episode_id, embedding, model)
         VALUES ($1, $2, $3)`,
        [epId, `[${embedding.join(",")}]`, MODEL],
      );
      done++;
      console.log(`  ✓ Ep ${epId} embedded (${done + skipped}/${episodes.rows.length})`);
    } catch (e) {
      console.error(`  ✗ Ep ${epId} failed: ${e.message}`);
    }
  }
}

console.log(`\n=== Embeddings complete: ${done} new, ${skipped} skipped ===`);

// Verify
const count = await pg.queryArray("SELECT COUNT(*) FROM episode_embeddings");
console.log(`Total embeddings in DB: ${count.rows[0][0]}`);

await pg.end();
