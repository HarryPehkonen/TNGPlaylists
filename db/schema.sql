-- TNGPlaylists — PostgreSQL schema
-- Mirrors the SQLite schema from the TNG transcript project (tng_data.db),
-- with additions for the web app: summaries (JSON), playlists, and pgvector embeddings.

-- ============================================================================
-- Core TNG data (mirrors SQLite schema)
-- ============================================================================

CREATE TABLE IF NOT EXISTS seasons (
    season_number INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS episodes (
    episode_id          SERIAL PRIMARY KEY,
    season              INTEGER NOT NULL REFERENCES seasons(season_number),
    episode_number      INTEGER NOT NULL,
    episode_end         INTEGER NOT NULL DEFAULT 0,
    title               TEXT,
    site_transcript_id  INTEGER,
    filename            TEXT NOT NULL,
    original_air_date   TEXT,
    us_viewers_millions REAL,
    UNIQUE (season, episode_number)
);

CREATE TABLE IF NOT EXISTS characters (
    character_id    SERIAL PRIMARY KEY,
    character_name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS line_counts (
    episode_id    INTEGER NOT NULL REFERENCES episodes(episode_id),
    character_id  INTEGER NOT NULL REFERENCES characters(character_id),
    line_count    INTEGER NOT NULL,
    PRIMARY KEY (episode_id, character_id)
);

CREATE TABLE IF NOT EXISTS categories (
    category_id  SERIAL PRIMARY KEY,
    category_key TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL,
    kind         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keywords (
    keyword_id     SERIAL PRIMARY KEY,
    canonical      TEXT NOT NULL UNIQUE,
    tier           TEXT NOT NULL,
    case_sensitive BOOLEAN NOT NULL,
    needs_context  BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS keyword_categories (
    keyword_id  INTEGER NOT NULL REFERENCES keywords(keyword_id),
    category_id INTEGER NOT NULL REFERENCES categories(category_id),
    PRIMARY KEY (keyword_id, category_id)
);

CREATE TABLE IF NOT EXISTS keyword_variants (
    keyword_id INTEGER NOT NULL REFERENCES keywords(keyword_id),
    variant    TEXT NOT NULL,
    PRIMARY KEY (keyword_id, variant)
);

CREATE TABLE IF NOT EXISTS keyword_counts (
    episode_id  INTEGER NOT NULL REFERENCES episodes(episode_id),
    keyword_id  INTEGER NOT NULL REFERENCES keywords(keyword_id),
    occurrences INTEGER NOT NULL,
    PRIMARY KEY (episode_id, keyword_id)
);

CREATE TABLE IF NOT EXISTS people (
    person_id SERIAL PRIMARY KEY,
    name      TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS credits (
    episode_id INTEGER NOT NULL REFERENCES episodes(episode_id),
    person_id  INTEGER NOT NULL REFERENCES people(person_id),
    role       TEXT NOT NULL,
    PRIMARY KEY (episode_id, person_id, role)
);

-- ============================================================================
-- Broadcast-order views (mirrors SQLite views)
-- ============================================================================

-- One row per broadcast episode slot (double episodes expand to multiple rows)
CREATE OR REPLACE VIEW episode_slots AS
    WITH RECURSIVE slots(episode_id, season, episode_number, last) AS (
        SELECT episode_id, season, episode_number, episode_end FROM episodes
        UNION ALL
        SELECT episode_id, season, episode_number + 1, last
          FROM slots WHERE episode_number < last
    )
    SELECT episode_id, season, episode_number FROM slots;

CREATE OR REPLACE VIEW episode_index AS
    SELECT ep.title, sl.season, sl.episode_number, ep.episode_id,
           ep.site_transcript_id, ep.filename
      FROM episode_slots sl JOIN episodes ep USING(episode_id);

CREATE OR REPLACE VIEW episode_credits AS
    SELECT ep.season, ep.episode_number, ep.title,
           p.name AS person, c.role
      FROM credits c
      JOIN people p    USING(person_id)
      JOIN episodes ep USING(episode_id);

CREATE OR REPLACE VIEW keyword_episode_counts AS
    SELECT ep.season, ep.episode_number, ep.title,
           k.canonical AS keyword, k.tier, kc.occurrences
      FROM keyword_counts kc
      JOIN keywords k  USING(keyword_id)
      JOIN episodes ep USING(episode_id);

CREATE OR REPLACE VIEW category_counts AS
    SELECT ep.season, ep.episode_number, ep.title,
           c.category_key, c.label, SUM(kc.occurrences) AS occurrences
      FROM keyword_counts kc
      JOIN keyword_categories kcat USING(keyword_id)
      JOIN categories c            USING(category_id)
      JOIN episodes ep             USING(episode_id)
     GROUP BY ep.episode_id, c.category_id;

-- ============================================================================
-- Web app additions
-- ============================================================================

-- AI-generated episode summaries (from the docsum pipeline, JSON format)
CREATE TABLE IF NOT EXISTS episode_summaries (
    episode_id     INTEGER PRIMARY KEY REFERENCES episodes(episode_id),
    characters     JSONB NOT NULL DEFAULT '[]',
    places         JSONB NOT NULL DEFAULT '[]',
    themes         JSONB NOT NULL DEFAULT '[]',
    key_events     JSONB NOT NULL DEFAULT '[]',
    species        JSONB NOT NULL DEFAULT '[]',
    technology     JSONB NOT NULL DEFAULT '[]',
    moral_dilemma  TEXT NOT NULL DEFAULT '',
    source_file    TEXT,
    generated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (episode_id)
);

-- Vector embeddings of the episode summary for semantic search.
-- Requires the pgvector extension. Embedding model: voyageai/voyage-4 (1024 dims).
CREATE TABLE IF NOT EXISTS episode_embeddings (
    episode_id  INTEGER PRIMARY KEY REFERENCES episodes(episode_id),
    embedding   vector(1024),
    model       TEXT NOT NULL DEFAULT 'voyageai/voyage-4',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Playlists: curated or smart (query-based)
CREATE TABLE IF NOT EXISTS playlists (
    playlist_id   SERIAL PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    description   TEXT NOT NULL DEFAULT '',
    is_smart      BOOLEAN NOT NULL DEFAULT FALSE,
    -- For smart playlists: a JSON description of the filter criteria
    -- e.g. {"category": "place", "value": "Risa"} or {"character": "Q"}
    criteria      JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Playlist membership (for curated playlists)
CREATE TABLE IF NOT EXISTS playlist_episodes (
    playlist_id   INTEGER NOT NULL REFERENCES playlists(playlist_id) ON DELETE CASCADE,
    episode_id    INTEGER NOT NULL REFERENCES episodes(episode_id) ON DELETE CASCADE,
    position      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (playlist_id, episode_id)
);

-- Indexes for the query patterns the web app will use
CREATE INDEX IF NOT EXISTS idx_episodes_season ON episodes(season, episode_number);
CREATE INDEX IF NOT EXISTS idx_line_counts_char ON line_counts(character_id);
CREATE INDEX IF NOT EXISTS idx_keyword_counts_kw ON keyword_counts(keyword_id);
CREATE INDEX IF NOT EXISTS idx_credits_person ON credits(person_id);
CREATE INDEX IF NOT EXISTS idx_playlist_episodes_pos ON playlist_episodes(playlist_id, position);
