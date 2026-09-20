# INCIDENTS — every real failure, and the check that now catches it

Newest first. One entry per incident that changed how this repo works.

The rule: **when something breaks, the fix is not done until a check exists that would have caught
it, and the incident is written here next to that check.** A check with no written rationale looks
arbitrary to the next hurried contributor (or agent), and arbitrary checks get deleted. The
rationale is the load-bearing part.

    ## YYYY-MM-DD — <one-line failure>
    What broke:        <the user-visible symptom>
    Check added:       <file> + <gate stage that now catches it>
    Why it must stay:  <why deleting this check re-enables the bug>

## Deliberate deviations from the AI-DEV-STARTER gate, and why

`scripts/gate.sh` is adapted from the kit's `templates/deno/gate.sh`. One stage differs on purpose,
because of what this particular tree already contained on 2026-09-19: `format` tolerates drift that
was already at `HEAD` (the entry below). Everything else — the
env/lint/tests/format/artifact-identity order, the touched-file list, the `GATE PASSED` verdict — is
the kit's.

A second deviation lived here from 2026-09-19 to 2026-09-20: a **lint ratchet**. It is gone. The
21-problem backlog it excused was cleared and the ratchet was deleted in the same commit — see the
entry below for the measurement that showed the ratchet was _hiding_ a swapped violation, not merely
tolerating a pre-existing one.

---

## 2026-09-20 — the lint ratchet was excusing a SWAPPED violation, so it was excusing nothing

What broke: The stage compared a touched file's violation **count** now against the count the same
file had at `HEAD`, and failed only if the count went up. That is not "no new problems": a file with
one violation at `HEAD` can trade it for a different one and the count never moves. Measured on
`api/characters.ts` — `deno lint` on the `HEAD` blob reports `Found 1 problem` (its unpinned
`jsr:@oak/oak` import); the same file with that import pinned **and** a brand-new `no-unused-vars`
injected reports 1 problem, so `now (1) > was (1)` is false and the old stage passed. The 13
unpinned imports were also the kind of problem a ratchet licenses you to keep forever: the verdict
then depended on which packages were published when, not on the code. Check added: the lint stage is
now absolute (the whole tree, no baseline), and the 21 problems were fixed rather than excused — 13
imports pinned to the exact versions already in `deno.lock` (`@oak/oak@17.2.0`,
`@db/postgres@0.19.5`, `@db/sqlite@0.13.0`), 5 unused symbols deleted (`q`, `res` and a
`let`→`const` in `scripts/seed.ts`, `esc` in `web/app.js`, two unused `queryArray` imports), 2
`any`s typed as Oak's `Context`. Evidence: the same one-violation probe now prints
`api/characters.ts:11:7` and `GATE FAILED` (rc 1). Why it must stay deleted: restoring a count-based
ratchet restores the blind spot, and a stage that reports "21 known problems" is one every reader
learns to skip. The trade this accepts: `deno lint`'s rule set is whatever the installed Deno tags
`recommended`, so a Deno upgrade that adds a rule turns this red with no code change — the fix is
then an explicit rule decision in `deno.json` (which already declares `lint.rules.tags`), never a
re-installed baseline. The gate prints the Deno version in its `env` stage, which is what makes that
diagnosable.

---

## 2026-09-20 — four pages loaded their stylesheet and scripts unversioned

What broke: The artifact-identity pair only ever looked for `?v=` values — it validated the ones it
found in `web/index.html` and said nothing about the four static pages (`about`, `privacy`, `terms`,
`copyright`), which loaded `/styles.css`, `/email.js` and `/account-actions.js` bare. A returning
visitor keeps the old stylesheet (or the old `account-actions.js`) after a deploy: the same
invisible-deploy bug the pair exists for, one page over. Check added: `?v=` on all eleven local
asset references across the five pages, and the identity stage now flags **any** `/`-rooted
`.css`/`.js` reference with no `?v=`, not just a mismatched one; `tests/deno/app_version_test.ts`
asserts the same rule over the pages it enumerates from disk, plus a synthetic case proving the
checker can fail. Evidence: de-versioning `/styles.css` in `web/about.html` makes the gate print
`web/about.html:href="/styles.css"` with `GATE FAILED` (rc 1) and fails the test by name. Why it
must stay: A page is the unit the browser caches. A rule that only inspects references which already
carry a version cannot see a reference that has none — which is exactly the state a newly added page
starts in.

---

## 2026-09-19 — the tree arrived with 21 lint problems, so a whole-tree lint stage could never pass

What broke: `deno lint` on `HEAD` reports 21 problems in 13 files (`no-explicit-any` on the Oak
middleware signatures in `api/auth.ts`, an unused helper in `web/app.js`, and friends). A gate whose
lint stage fails on the first run is a gate everybody learns to bypass — and the pre-commit hook
would have blocked every commit, including the ones that were busy adding tests. Check added:
`scripts/gate.sh` lint stage, a **ratchet**: it lints the whole tree, then for every touched file
compares the number of violations now against the number the same file had at `HEAD` (it lints a
copy of the `HEAD` blob) and fails only if the count went up. Pre-existing problems are reported in
one line ("no new lint problems in the N file(s) this branch touches (21 pre-existing in the
tree)"); an untouched file's problems are reported as "not mine". Why it must stay: Removing the
`HEAD` comparison makes every unrelated edit to `api/auth.ts` or `web/app.js` a hard failure, and
the escape hatch for that is `--no-verify` — which disables the tests and the identity check too.
Keeping only a "touched files" lint and dropping the whole-tree run would stop the 21 problems from
ever being visible. The ratchet is what makes a dirty tree workable without pretending it is clean:
fix one file and its next violation is caught.

---

## 2026-09-19 — every HTML page in the repo is non-compliant with its own formatter

What broke: `deno fmt --check web/index.html` (and the other four pages) wants to reindent the whole
file. Adding one `?v=` to an asset URL therefore made the format stage fail on a change whose only
real edit was four characters — the reformat would have been a five-file whitespace diff inside a
baseline commit, which is exactly the noise the touched-file rule exists to avoid. Check added:
`scripts/gate.sh` format stage: for each touched file it also checks the file **as it was at
`HEAD`**; if that copy was already unformatted, the drift is reported as pre-existing and does not
fail the gate. A file this change made unformatted still fails, and a brand-new file must be clean
(it has no `HEAD` copy to excuse it). Why it must stay: Removing the `HEAD` comparison restores the
trap: touching a page for an unrelated reason would force a whole-file reformat or a bypassed hook.
The stage stays self-healing: once a page is formatted, its `HEAD` copy is clean, and it is enforced
from then on.

---

## 2026-09-19 — a route's `method:` is not always a literal, and the first extractor read it as GET

What broke: `web/app.js` marks an episode watched with `api(\`/watched/${id}\`, { method: nowWatched
? "PUT" : "DELETE"
})`.
                   The route-contract extractor read one method per call site and
                   would have defaulted this one to GET — reporting`PUT/DELETE
/api/watched/:param`as a mismatch against a server
                   that serves both. A guard that cries wolf gets switched off.
Check added:`tests/deno/route_contract.ts``methodsFromOptions()`collects
                   every method literal in the options object, so one call site
                   yields two calls;`route_contract_test.ts`
pins the pair with a synthetic case ("one call site, two methods"), and the real-repo test asserts
the exact number of dynamic (unreadable) call sites. Why it must stay: The count assertion is the
part that matters: a third shape of call site that the extractor cannot read has to fail loudly, not
be silently skipped. Reverting to a single-method assumption brings back a false failure the first
time someone writes a toggle.

---

## 2026-09-19 — the client uses two URL conventions at once, and one of them doubles the prefix

What broke: `web/app.js` composes `API_BASE + path` inside its `api()` helper, while
`web/account-actions.js` calls `fetch("/api/auth/me")` with the prefix already in the string. An
extractor that assumes "a path never carries its own prefix" silently treats the account-actions
calls as relative, and the doubled-prefix bug this test class exists for (see the Notes app's
2026-09-18 incident) would slip through. Check added: `tests/deno/route_contract.ts` decides
relative-vs-absolute from the **call shape** (`api(...)` is relative, a literal `fetch("/...")` and
a `href = "/api/..."` navigation are absolute), never from what the string looks like — so
`api("/api/x")` still fails as `/api/api/x`, pinned by the synthetic "doubled prefix" test. Why it
must stay: Inferring the shape from the string is exactly how a checker becomes unable to see the
bug it was written for. The call shape is the fact; the string is the symptom.

---

## 2026-09-19 — a path's query string can live inside the interpolation

What broke: The keyword filter is built as
``api(`/keywords${cat ? `?category=${encodeURIComponent(cat)}` : ""}`)``. A normalizer that replaces
each `${...}` with a segment read that as `/keywords:param` and reported a mismatch against the real
`/api/keywords` route. The `?` is inside the expression, so "drop everything after the question
mark" never fired. Check added: `tests/deno/route_contract.ts` `normalizePath()` turns a `${...}`
into one `:param` **only when it sits where a segment belongs**; anywhere else it ends the readable
path. Pinned by synthetic tests for both shapes (`/episodes/${id}` and the keywords case). Why it
must stay: Guessing what an interpolation contains is how a contract test starts describing a URL
nobody writes. Reading less, and saying so, is the honest half of the check.

---

## 2026-09-19 — the envelope checker itself cried wolf: an early-return 404 is not the reply's status

What broke: The first version of the envelope check took "the last `ctx.response.status` set
anywhere above this body" as the reply's status. Five routes set a 404 (or 400) inside an
early-return guard and then assign a perfectly enveloped success body further down; all five were
reported as "a body on a 204". The check was wrong, not the code. Check added:
`tests/deno/envelope.ts` only accepts a status assignment that sits **immediately** above the body
assignment (whitespace and comments in between), and a synthetic test ("a status set in an earlier
branch is not this reply's status") pins that it stays that way. Why it must stay: The looser rule
makes the checker produce false failures on the most ordinary handler shape in the codebase — and a
check that fires on correct code is the fastest route to `--no-verify`.

---

## 2026-09-19 — the baseline could not create `CLAUDE.md`: it is a protected agent-instruction file

What broke: The card asked for `CLAUDE.md` from the kit's template. Writing it opens an approval
prompt (agent-instruction files are protected), and this change ran headless, so the prompt timed
out and the write was refused — correctly: silence is not consent. Check added: No check can catch
this one. The contract was written to `docs/PROJECT-CONTRACT.md` instead, with the reason at the top
of that file, and activating it is one human action: `git mv docs/PROJECT-CONTRACT.md CLAUDE.md`
(plus the prompt). Second attempt (2026-09-20, card `t_b7a6fa85`): the install was attempted again
through the file-write tool with the finished document as the content, and refused again with
`BLOCKED: write to protected agent-instruction file(s) (CLAUDE.md) approval prompt timed out without
a user response. Silence is not consent.`
No retry, no shell workaround, no rename-and-edit — the one-command activation above is still the
only path, and this is a deliberate limit of unattended runs, not a bug to route around. Why it must
stay: A future agent that finds the contract in `docs/` and wonders why should not "tidy" it into
`CLAUDE.md` and trip the same guard mid-run. If the move happens, delete this entry and the note at
the top of the file — the incident is over.
