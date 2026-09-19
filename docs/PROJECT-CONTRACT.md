# TNGPlaylists — the contract for whoever (or whatever) works in this repo

<!--
WHY THIS FILE IS NOT NAMED CLAUDE.md YET: this repo's CLAUDE.md is one of the
protected agent-instruction files — creating it opens an approval prompt, and the
baseline change that wrote this file ran without a human at the keyboard, so the
prompt timed out and the write was refused (correctly). The content is complete;
only the name is pending. To activate it, a human runs:

    git mv docs/PROJECT-CONTRACT.md CLAUDE.md

and approves the prompt. Until then this file is the same contract, one directory
further away — better than a missing document, and honest about which half is done.
-->

## What this is

A read-mostly web app for browsing Star Trek: The Next Generation episodes and building playlists
from them: 176 episodes with per-character line counts, keyword frequency, production credits, and
generated summaries, plus a hybrid search (structured filters + pgvector cosine similarity). Deno
2 + Oak on the server, vanilla JS with no build step in the browser, PostgreSQL 17 + pgvector behind
both. "Working" means: `scripts/gate.sh` prints `GATE PASSED`, and the tabs (Episodes, Playlists,
Admin, plus the episode modal) do what they say against a seeded database.

## Commands

| What                                               | Command                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Dependencies                                       | none to install — Deno fetches `jsr:@oak/oak` / `jsr:@db/postgres` on first run and pins them in `deno.lock`           |
| **Run the gate (before you claim anything works)** | `scripts/gate.sh`                                                                                                      |
| Tests only                                         | `deno task test`                                                                                                       |
| Tests including the live HTTP check                | `DATABASE_URL=postgres://tng_user:***@localhost:5432/tngplaylists deno task test`                                      |
| Lint only                                          | `deno task lint`                                                                                                       |
| Format the files you touched                       | `deno fmt <files>`                                                                                                     |
| Run it locally                                     | `deno task pg:start` then `DATABASE_URL=postgres://tng_user:***@localhost:5432/tngplaylists PORT=8090 deno task start` |
| Local Postgres (systemd cluster on 5432)           | `deno task pg:start` / `pg:stop` / `pg:status`                                                                         |
| Seed / re-embed / search from the CLI              | `deno task seed` / `deno task embeddings` / `deno task search "query"`                                                 |
| Deploy                                             | not in this repo — the VPS steps live in the `vps-deno-app-deployment` skill (see "Gaps" below)                        |

The gate's last line is the verdict: `GATE PASSED` or `GATE FAILED`. Never report work as done on a
run that did not print `GATE PASSED`. If a stage says it skipped something (today: the live HTTP
check, when `DATABASE_URL` is unset), say so explicitly — a skipped check is not a passed check.

## Architecture

    web/*.html, web/app.js  --fetch /api/...-->  api/main.ts (Oak)
                                                 |  middlewares: log, CORS,
                                                 |  error, /api/health
                                                 |  routers x7 (auth, episodes,
                                                 |  characters, search, keywords,
                                                 |  playlists, watched)
                                                 |  -> api/db.ts queryObject()
                                                 v
                                             PostgreSQL (pgvector, db/schema.sql)

- Seams: the route table is the `app.use(...Router.routes())` block in `api/main.ts`; the schema is
  `db/schema.sql` (+ `db/auth_schema.sql`); the data pipeline is `scripts/seed.ts` then
  `scripts/embeddings.ts`; the tests' view of the repository is `tests/deno/repo.ts`.
- Every API reply is the envelope `{ success, data }` / `{ success, error }`, and the browser parses
  it in exactly one place: `api()` in `web/app.js`.
- Everything not under `/api/` is a static file from `web/` (Oak's `send()`), so a page and its
  assets share the API's origin.
- **Routers carry their own full path** (`episodesRouter.get("/api/episodes", ...)`) and
  `api/main.ts` mounts them with no prefix (`app.use(episodesRouter.routes())`).

## Invariants

- **The build number, in two copies.** `web/version.js` `APP_VERSION` must equal every `?v=` on the
  asset references in `web/*.html` (today: `/styles.css` and `/app.js` in `web/index.html`).
  Enforced by the artifact-identity stage of `scripts/gate.sh` and by
  `tests/deno/app_version_test.ts`. The gate also fails when anything under `web/` changes without
  `web/version.js` changing. To bump: edit `web/version.js` **and** the `?v=` values in
  `web/index.html` in the same commit. `web/version.js` is the copy a human reads; the `?v=` is the
  copy the browser caches under (Oak's `send()` ignores the query string, so the bytes served are
  identical).
- **The response envelope.** Every route answers with an object carrying `success`; `success: true`
  carries `data`, `success: false` carries an `error` message; a route with no body follows a 204.
  Enforced by `tests/deno/envelope_test.ts` and, over HTTP, by `tests/deno/api_live_test.ts`.
- **The client/server URL contract.** Every URL the browser calls or navigates to resolves to a
  route the server serves, by method. Enforced by `tests/deno/route_contract_test.ts`.

## Conventions

- Tests live in `tests/deno/`. A test file must be named `*_test.ts` or `deno task
  test` will not
  run it — a silently unrun test is worse than no test. Pure extractors/analyzers live next to them
  without the suffix (`route_contract.ts`, `envelope.ts`, `app_version.ts`, `repo.ts`).
- **Derive, never list.** A test that needs "every router" or "every client file" gets it from
  `tests/deno/repo.ts`, which reads `api/main.ts`'s imports and the `web/` directory. Adding a name
  to a list is how the next router escapes the check.
- Every contract check needs two halves: synthetic cases that prove the checker **can fail**, and an
  assertion on the real repository. A guard that has never failed is a guess.
- Non-vacuity is asserted too: the extractors must find a plausible number of call
  sites/routes/assignments, and any site they cannot read statically is counted exactly, so a new
  one has to be reviewed by hand rather than silently skipped.
- Commits: lowercase imperative subject, optional `area:` prefix, one logical change each
  (`playlist picker: show description under each playlist name`). No `feat:`/`fix:` prefixes in this
  repo's history; match it.
- Markdown and JS/TS here are `deno fmt` formatted with the config in `deno.json` (100 columns,
  2-space indent, double quotes, semicolons).

## Gotchas

<!-- APPEND-ONLY. One line each, newest first, and each one is a real incident. -->

- The tree arrived with **21 pre-existing lint problems in 13 files**. The gate's lint stage is a
  ratchet: it lints the whole tree but fails only on a violation a file did not already have at
  `HEAD`, so touching `api/auth.ts` for an unrelated reason is not a lint pass-or-fail event. Fix a
  file's problems and its next violation is caught — do not silence the rules to shrink the number.
- `web/*.html` arrived **unformatted** (`deno fmt` wants to reindent all five pages). The format
  stage tolerates drift that was already at `HEAD` and fails only on drift the change introduced.
- The two client files disagree about URL shape on purpose: `web/app.js` composes relative paths
  onto `API_BASE` via `api()`, `web/account-actions.js` calls `fetch("/api/auth/me")` with the
  prefix already in the string. The contract test keys off the **call shape**, so both are checked,
  and `api("/api/x")` still fails as `/api/api/x`.
- A `method:` is not always a literal: `api(\`/watched/${id}\`, { method: nowWatched ? "PUT" :
  "DELETE" })` is two call sites (PUT and DELETE) out of one line.
- A `${...}` in a path can carry the whole query string:
  ``api(`/keywords${cat ? `?category=${cat}` : ""}`)``. The contract test reads the path as
  `/keywords` and stops — never guess inside an interpolation.
- Error replies are enveloped too, and the client shows `data?.error`; a `{ success: false }`
  without an `error` string renders as "HTTP 500".
- Three routes answer with **no body and a 204** (`DELETE /api/playlists/:id`,
  `DELETE /api/playlists/:id/episodes/:episodeId`, `DELETE /api/watched/:episodeId`); `web/app.js`
  turns 204 into `null`. A further bodiless route has to be a deliberate decision — a test pins the
  list.
- `/api/health` is a middleware in `api/main.ts`, not a router, so it appears in no router file. The
  route model reads it from the `pathname ===` comparison.
- `api/main.ts` mounts routers with no prefix, and `send()` serves everything not under `/api/` from
  `web/`. A new router must carry `/api/...` in its own paths or it will be shadowed by the static
  fallthrough.
- `deno task lint` / `test` / `fmt` did not exist before this baseline; the gate fails if a task it
  calls is missing, which is deliberate.
- No test needs a database. The live HTTP check (`api_live_test.ts`) runs only when `DATABASE_URL`
  is set, and prints that it skipped otherwise.
- Comments in `api/*.ts` mention port **5434** (the old user-owned cluster). The live local cluster
  is the systemd Postgres 17 on **5432** (`deno task pg:*`).
- `COUNT(*)` comes back from `@db/postgres` as a BigInt, and `JSON.stringify` throws on it — cast in
  SQL (`COUNT(...)::int`).

## Do not

- Do not "fix" the gate by deleting a check. Every check carries its incident in `INCIDENTS.md`; if
  you believe a check is wrong, say so in a comment and let a human decide.
- Do not commit `DATABASE_URL`, the local dev password, the Google OAuth client secret, or session
  cookies. They come from the environment; nothing in this repo needs them to be committed.
- Do not add a route without adding the client call (or vice versa) in the same change — the
  contract test is what makes that safe, not a review habit.
- Do not introduce a service worker without wiring the artifact-identity pair to its cache name;
  today the `?v=` on `web/index.html` is the whole cache story.
- Do not change `web/index.html`'s asset references without bumping `web/version.js`, and do not
  reformat `web/*.html` unless you mean to (the format stage stops tolerating it for that file once
  you do).

## Gaps

- `README.md` is two lines and there is no in-repo deploy doc; the VPS deploy (Deno + Postgres over
  SSH) is covered by the `vps-deno-app-deployment` skill.
- Four static pages (`about`, `privacy`, `terms`, `copyright`) load `/styles.css` and `/email.js`
  **unversioned**, so a stylesheet change can serve stale CSS there. Versioning them means
  reformatting four HTML files that arrived unformatted — a deliberate follow-up, not an oversight.

## Incidents

Every rule above that came from a failure is written down in `INCIDENTS.md` with the symptom, the
check that now catches it, and why deleting the check re-enables the bug. Read it before removing
anything that looks redundant.
