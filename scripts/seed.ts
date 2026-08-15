#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env
/**
 * TNGPlaylists — seed script
 *
 * Reads the TNG transcript SQLite database (tng_data.db) and the docsum
 * episode summaries (summaries/*.JSON), then populates the Postgres
 * database for the TNGPlaylists web app.
 *
 * Usage:
 *   deno run --allow-read --allow-net --allow-env scripts/seed.ts
 *
 * Connection via DATABASE_URL env var, e.g.:
 *   DATABASE_URL=postgres://tng_user:PASS@host:5432/tngplaylists
 */

import { Database } from "jsr:@db/sqlite";
import { Client } from "jsr:@db/postgres";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DB_URL = Deno.env.get("DATABASE_URL");
if (!DB_URL) {
  console.error("DATABASE_URL not set — e.g. postgres://tng_user:PASS@host:5432/tngplaylists");
  Deno.exit(1);
}

const SQLITE_PATH = Deno.env.get("SQLITE_PATH") ??
  "/home/harri/hermes-workspace/star_trek_tng_transcripts/tng_data.db";
const SUMMARIES_DIR = Deno.env.get("SUMMARIES_DIR") ??
  "/home/harri/hermes-workspace/star_trek_tng_transcripts/summaries";

// ---------------------------------------------------------------------------
// Open connections
// ---------------------------------------------------------------------------

const sqlite = new Database(SQLITE_PATH);
const pg = new Client(DB_URL);
await pg.connect();

console.log("✓ Connected to SQLite:", SQLITE_PATH);
console.log("✓ Connected to Postgres");

// ---------------------------------------------------------------------------
// Schema — load DDL from db/schema.sql
// ---------------------------------------------------------------------------

const schemaPath = new URL("../db/schema.sql", import.meta.url).pathname;
const schema = await Deno.readTextFile(schemaPath);

// The schema uses IF NOT EXISTS, so this is idempotent. But the vector
// table needs the pgvector extension — try to create it (may fail if
// pgvector isn't installed; that's handled separately).
await pg.queryArray("CREATE EXTENSION IF NOT EXISTS vector").catch((e) => {
  console.warn("⚠ pgvector extension not available:", e.message);
});

await pg.queryArray(schema);
console.log("✓ Schema loaded");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function q(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Batch multi-row insert. Builds a single INSERT with many VALUES tuples
 * (parameterized), which is dramatically faster than row-by-row inserts.
 * Returns the number of rows processed.
 */
async function batchInsert(
  table: string,
  columns: string[],
  rows: (string | number | boolean | null)[][],
  onConflict: string = "ON CONFLICT DO NOTHING",
  chunkSize: number = 500,
): Promise<number> {
  const colList = columns.join(", ");
  let processed = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const valuePlaceholders = chunk.map((_, r) =>
      `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(", ")})`
    ).join(", ");
    const params = chunk.flat();
    await pg.queryArray(
      `INSERT INTO ${table} (${colList}) VALUES ${valuePlaceholders} ${onConflict}`,
      params,
    );
    processed += chunk.length;
  }
  return processed;
}

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

const seasons = sqlite.prepare("SELECT season_number FROM seasons").all();
for (const s of seasons) {
  await pg.queryArray("INSERT INTO seasons (season_number) VALUES ($1) ON CONFLICT DO NOTHING", [s.season_number]);
}
console.log(`✓ Seasons: ${seasons.length}`);

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

const episodes = sqlite.prepare(`
  SELECT episode_id, season, episode_number, episode_end, title,
         site_transcript_id, filename, original_air_date, us_viewers_millions
    FROM episodes ORDER BY season, episode_number
`).all();

// Map SQLite episode_id -> Postgres episode_id (SERIAL, so we need the generated id)
const epIdMap = new Map<number, number>();

for (const e of episodes) {
  const res = await pg.queryArray(
    `INSERT INTO episodes
       (episode_id, season, episode_number, episode_end, title,
        site_transcript_id, filename, original_air_date, us_viewers_millions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (episode_id) DO UPDATE SET
       season = EXCLUDED.season,
       episode_number = EXCLUDED.episode_number,
       episode_end = EXCLUDED.episode_end,
       title = EXCLUDED.title,
       site_transcript_id = EXCLUDED.site_transcript_id,
       filename = EXCLUDED.filename,
       original_air_date = EXCLUDED.original_air_date,
       us_viewers_millions = EXCLUDED.us_viewers_millions`,
    [
      e.episode_id, e.season, e.episode_number, e.episode_end,
      e.title, e.site_transcript_id, e.filename,
      e.original_air_date, e.us_viewers_millions,
    ],
  );
  epIdMap.set(e.episode_id, e.episode_id);
}
console.log(`✓ Episodes: ${episodes.length}`);

// ---------------------------------------------------------------------------
// Characters + line counts
// ---------------------------------------------------------------------------

const characters = sqlite.prepare("SELECT character_id, character_name FROM characters ORDER BY character_id").all();
for (const c of characters) {
  await pg.queryArray(
    "INSERT INTO characters (character_id, character_name) VALUES ($1, $2) ON CONFLICT (character_id) DO UPDATE SET character_name = EXCLUDED.character_name",
    [c.character_id, c.character_name],
  );
}
console.log(`✓ Characters: ${characters.length}`);

const lineCounts = sqlite.prepare(
  "SELECT episode_id, character_id, line_count FROM line_counts",
).all();
await batchInsert(
  "line_counts", ["episode_id", "character_id", "line_count"],
  lineCounts.map((lc) => [lc.episode_id, lc.character_id, lc.line_count]),
);
console.log(`✓ Line counts: ${lineCounts.length}`);

// ---------------------------------------------------------------------------
// Categories, keywords, variants, keyword_categories, keyword_counts
// ---------------------------------------------------------------------------

const categories = sqlite.prepare("SELECT category_id, category_key, label, kind FROM categories ORDER BY category_id").all();
for (const c of categories) {
  await pg.queryArray(
    "INSERT INTO categories (category_id, category_key, label, kind) VALUES ($1, $2, $3, $4) ON CONFLICT (category_id) DO UPDATE SET category_key = EXCLUDED.category_key, label = EXCLUDED.label, kind = EXCLUDED.kind",
    [c.category_id, c.category_key, c.label, c.kind],
  );
}
console.log(`✓ Categories: ${categories.length}`);

const keywords = sqlite.prepare("SELECT keyword_id, canonical, tier, case_sensitive, needs_context FROM keywords ORDER BY keyword_id").all();
for (const k of keywords) {
  await pg.queryArray(
    "INSERT INTO keywords (keyword_id, canonical, tier, case_sensitive, needs_context) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (keyword_id) DO UPDATE SET canonical = EXCLUDED.canonical, tier = EXCLUDED.tier, case_sensitive = EXCLUDED.case_sensitive, needs_context = EXCLUDED.needs_context",
    [k.keyword_id, k.canonical, k.tier, k.case_sensitive, k.needs_context],
  );
}
console.log(`✓ Keywords: ${keywords.length}`);

const variants = sqlite.prepare("SELECT keyword_id, variant FROM keyword_variants").all();
await batchInsert(
  "keyword_variants", ["keyword_id", "variant"],
  variants.map((v) => [v.keyword_id, v.variant]),
);
console.log(`✓ Keyword variants: ${variants.length}`);

const kwCats = sqlite.prepare("SELECT keyword_id, category_id FROM keyword_categories").all();
await batchInsert(
  "keyword_categories", ["keyword_id", "category_id"],
  kwCats.map((kc) => [kc.keyword_id, kc.category_id]),
);
console.log(`✓ Keyword-categories: ${kwCats.length}`);

const kwCounts = sqlite.prepare("SELECT episode_id, keyword_id, occurrences FROM keyword_counts").all();
await batchInsert(
  "keyword_counts", ["episode_id", "keyword_id", "occurrences"],
  kwCounts.map((kc) => [kc.episode_id, kc.keyword_id, kc.occurrences]),
);
console.log(`✓ Keyword counts: ${kwCounts.length}`);

// ---------------------------------------------------------------------------
// People + credits
// ---------------------------------------------------------------------------

const people = sqlite.prepare("SELECT person_id, name FROM people ORDER BY person_id").all();
for (const p of people) {
  await pg.queryArray(
    "INSERT INTO people (person_id, name) VALUES ($1, $2) ON CONFLICT (person_id) DO UPDATE SET name = EXCLUDED.name",
    [p.person_id, p.name],
  );
}
console.log(`✓ People: ${people.length}`);

const credits = sqlite.prepare("SELECT episode_id, person_id, role FROM credits").all();
await batchInsert(
  "credits", ["episode_id", "person_id", "role"],
  credits.map((c) => [c.episode_id, c.person_id, c.role]),
);
console.log(`✓ Credits: ${credits.length}`);

// ---------------------------------------------------------------------------
// Episode summaries (from docsum JSON files)
// ---------------------------------------------------------------------------

// Map filename -> episode_id from SQLite
const filenameToEpId = new Map<string, number>();
for (const e of episodes) {
  filenameToEpId.set(e.filename, e.episode_id);
}

let summaryCount = 0;
for (const f of Deno.readDirSync(SUMMARIES_DIR)) {
  if (!f.name.endsWith(".JSON")) continue;

  // Filename like S01E03.JSON or S01E01-E02.JSON — find matching transcript file
  // Pattern: S{season}E{ep}(-E{ep})?.JSON
  const m = f.name.match(/^S(\d{2})E(\d{2})(?:-E(\d{2}))?\.JSON$/i);
  if (!m) {
    console.warn("  Skipping unrecognized summary filename:", f.name);
    continue;
  }

  const season = parseInt(m[1]);
  const epNum = parseInt(m[2]);

  // Find the episode in SQLite (need filename match: TNG_S{season}E{ep}.txt)
  // Double episodes have filename TNG_S1E01-E02.txt
  let filename = `TNG_S${season}E${String(epNum).padStart(2, "0")}.txt`;
  const transcriptFile = [...filenameToEpId.keys()].find(
    (k) => k === filename || k.startsWith(`TNG_S${season}E${String(epNum).padStart(2, "0")}-`),
  );
  if (!transcriptFile) {
    console.warn(`  No matching transcript for summary: ${f.name}`);
    continue;
  }

  const epId = filenameToEpId.get(transcriptFile)!;
  const summary = JSON.parse(await Deno.readTextFile(`${SUMMARIES_DIR}/${f.name}`));

  await pg.queryArray(
    `INSERT INTO episode_summaries
       (episode_id, characters, places, themes, key_events, species, technology, moral_dilemma, source_file)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (episode_id) DO UPDATE SET
       characters = EXCLUDED.characters,
       places = EXCLUDED.places,
       themes = EXCLUDED.themes,
       key_events = EXCLUDED.key_events,
       species = EXCLUDED.species,
       technology = EXCLUDED.technology,
       moral_dilemma = EXCLUDED.moral_dilemma,
       source_file = EXCLUDED.source_file`,
    [
      epId,
      JSON.stringify(summary.characters ?? []),
      JSON.stringify(summary.places ?? []),
      JSON.stringify(summary.themes ?? []),
      JSON.stringify(summary.key_events ?? []),
      JSON.stringify(summary.species ?? []),
      JSON.stringify(summary.technology ?? []),
      summary.moral_dilemma ?? "",
      f.name,
    ],
  );
  summaryCount++;
}
console.log(`✓ Summaries: ${summaryCount}`);

// ---------------------------------------------------------------------------
// Fix sequences (we inserted explicit IDs, so sequences must be advanced)
// ---------------------------------------------------------------------------

await pg.queryArray("SELECT setval(pg_get_serial_sequence('episodes', 'episode_id'), COALESCE(MAX(episode_id), 1)) FROM episodes");
await pg.queryArray("SELECT setval(pg_get_serial_sequence('characters', 'character_id'), COALESCE(MAX(character_id), 1)) FROM characters");
await pg.queryArray("SELECT setval(pg_get_serial_sequence('categories', 'category_id'), COALESCE(MAX(category_id), 1)) FROM categories");
await pg.queryArray("SELECT setval(pg_get_serial_sequence('keywords', 'keyword_id'), COALESCE(MAX(keyword_id), 1)) FROM keywords");
await pg.queryArray("SELECT setval(pg_get_serial_sequence('people', 'person_id'), COALESCE(MAX(person_id), 1)) FROM people");
console.log("✓ Sequences fixed");

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log("\n=== Seed complete ===");

// Quick verification counts
const counts = await pg.queryArray(`
  SELECT 'seasons' AS t, COUNT(*) FROM seasons
  UNION ALL SELECT 'episodes', COUNT(*) FROM episodes
  UNION ALL SELECT 'characters', COUNT(*) FROM characters
  UNION ALL SELECT 'line_counts', COUNT(*) FROM line_counts
  UNION ALL SELECT 'categories', COUNT(*) FROM categories
  UNION ALL SELECT 'keywords', COUNT(*) FROM keywords
  UNION ALL SELECT 'keyword_variants', COUNT(*) FROM keyword_variants
  UNION ALL SELECT 'keyword_categories', COUNT(*) FROM keyword_categories
  UNION ALL SELECT 'keyword_counts', COUNT(*) FROM keyword_counts
  UNION ALL SELECT 'people', COUNT(*) FROM people
  UNION ALL SELECT 'credits', COUNT(*) FROM credits
  UNION ALL SELECT 'episode_summaries', COUNT(*) FROM episode_summaries
`);
console.table(counts.rows);

await pg.end();
sqlite.close();
