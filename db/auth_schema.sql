-- TNGPlaylists auth schema (independent of Notes app — separate tables, separate OAuth client)
-- Apply: psql to tngplaylists DB. Idempotent (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS users (
  user_id      SERIAL PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  display_name TEXT,
  picture      TEXT,
  role         TEXT NOT NULL DEFAULT 'reader'
               CHECK (role IN ('reader', 'writer', 'admin')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_providers (
  user_id          INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,          -- 'google' (extensible: 'github', 'facebook')
  provider_sub     TEXT NOT NULL,          -- provider's stable user id
  PRIMARY KEY (provider, provider_sub)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,             -- sha256 hex of the random session token
  user_id    INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
