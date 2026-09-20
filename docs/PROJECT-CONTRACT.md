# TNGPlaylists — the contract for whoever (or whatever) works in this repo

<!--
WHY THIS FILE IS NOT NAMED CLAUDE.md: this repo's CLAUDE.md is a protected
agent-instruction file — creating it opens an approval prompt, and the two
unattended attempts to install this document (2026-09-19, and 2026-09-20 from card
t_b7a6fa85) both timed out and were refused. The content is complete; only the name
is pending. To activate it, a human runs:

    git mv docs/PROJECT-CONTRACT.md CLAUDE.md

and approves the prompt. Until then this file is the same contract, one directory
further away — better than a missing document, and honest about which half is done.
Do not have an agent "fix" the name by hand: the refusal is the guard working.
-->

## What this is

A read-mostly web app for browsing Star Trek: The Next Generation episodes and building playlists
from them: 176 episodes with per-character line counts, keyword frequency, production credits, and
generated summaries, plus a hybrid search (structured filters + pgvector cosine similarity). Deno
2 + Oak on the server, vanilla JS with no build step in the browser, PostgreSQL 17 + pgvector behind
both. "Working" means: `scripts/gate.sh` prints `GATE PASSED`, and the tabs (Episodes, Playlists,
Admin, plus the episode modal) do what they say against a seeded database.

## Commands

| What                                               | Command                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependencies                                       | none to install — every `jsr:` import pins its own version in the source (`@oak/oak@17.2.0`, `@db/postgres@0.19.5`, `@db/sqlite@0.13.0`), and `deno.lock` resolves exactly those |
| **Run the gate (before you claim anything works)** | `scripts/gate.sh`                                                                                                                                                                |
| Tests only                                         | `deno task test`                                                                                                                                                                 |
| Tests including the live HTTP check                | `DATABASE_URL=postgres://tng_user:***@localhost:5432/tngplaylists deno task test`                                                                                                |
| Lint only                                          | `deno task lint`                                                                                                                                                                 |
| Format the files you touched                       | `deno fmt <files>`                                                                                                                                                               |
| Run it locally                                     | `deno task pg:start` then `DATABASE_URL=postgres://tng_user:***@localhost:5432/tngplaylists PORT=8090 deno task start`                                                           |
| Local Postgres (systemd cluster on 5432)           | `deno task pg:start` / `pg:stop` / `pg:status`                                                                                                                                   |
| Seed / re-embed / search from the CLI              | `deno task seed` / `deno task embeddings` / `deno task search "query"`                                                                                                           |
| Deploy                                             | not in this repo — the VPS steps live in the `vps-deno-app-deployment` skill (see "Gaps" below)                                                                                  |

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

- **The build number, in two copies.** `web/version.js` `APP_VERSION` must equal the `?v=` on
  **every local asset reference** (a `/`-rooted `.css` or `.js`) in **every page** under `web/` —
  the entry point and the four static pages alike. Enforced by the artifact-identity stage of
  `scripts/gate.sh` and by `tests/deno/app_version_test.ts`; the gate also fails when anything under
  `web/` changes without `web/version.js` changing. To bump: edit `web/version.js` **and** every
  `?v=` in the same commit. `web/version.js` is the copy a human reads; the `?v=` is the copy the
  browser caches under (Oak's `send()` ignores the query string, so the bytes served are identical).
  A new page that loads an asset bare fails the check — that is the point.
- **Lint is absolute.** `deno task lint` must report zero problems on the whole tree; there is no
  baseline and no "pre-existing" allowance. Imports are pinned to exact versions so the verdict is a
  property of the code, not of the calendar.
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

- The tree arrived with **21 lint problems in 13 files**. They were cleared on 2026-09-20 and the
  ratchet that excused them was deleted in the same commit: `deno task lint` is now absolute, so one
  new problem anywhere fails the gate. The backlog was 13 unpinned `jsr:` imports (now pinned to the
  exact versions in `deno.lock`), 5 unused symbols, 2 `any`s, 1 `let`. Do not silence a rule to
  shrink a number — `deno.json`'s `lint.rules.tags` is the one place the rule set is chosen, and
  changing it is a decision, not a cleanup.
- **15 of 36 files arrived unformatted** (all five pages, `web/app.js`, `web/account-actions.js`,
  `web/styles.css`, `README.md`, `api/{auth,main,playlists}.ts`,
  `scripts/{seed,search,embeddings}.ts`). The format stage tolerates drift that was already at
  `HEAD` and fails only on drift the change introduced, which is why editing one of them does not
  force a whole-file reformat. Reformatting the tree is a commit of its own, never a side effect of
  a fix.
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
  today the `?v=` on each page's assets is the whole cache story.
- Do not change any page's asset references without bumping `web/version.js`, and do not reformat
  `web/*.html` unless you mean to (the format stage stops tolerating it for that file once you do).

## Gaps

- `README.md` is two lines and there is no in-repo deploy doc; the VPS deploy (Deno + Postgres over
  SSH) is covered by the `vps-deno-app-deployment` skill.
- `deno check` is **not** part of the gate, and it reports 2 pre-existing type errors in
  `scripts/embeddings.ts` (`unknown[]` where `(string | number | null)[]` is expected; `e.message`
  on an `unknown`). `api/main.ts`, `scripts/seed.ts` and `scripts/search.ts` check clean. Those two
  are what a `types` stage would have to fix first — deliberately left alone here, because the fix
  is a decision about the row type, not a typo.

## Incidents

Every rule above that came from a failure is written down in `INCIDENTS.md` with the symptom, the
check that now catches it, and why deleting the check re-enables the bug. Read it before removing
anything that looks redundant.
