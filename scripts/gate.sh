#!/usr/bin/env bash
#
# The gate — run this before you commit, and before you push (and before deploy).
#
# Why this file exists instead of CI: the checks that keep this app honest are
# cheap (a 2-second suite, a 1-second lint) and they belong to the repo, not to
# somebody else's account. One definition, three callers:
#
#   1. a human, by hand            scripts/gate.sh
#   2. git, on commit and on push  .githooks/pre-commit, .githooks/pre-push
#                                  (arm once per clone: git config core.hooksPath .githooks)
#   3. a clean checkout elsewhere  the Pi's nightly job (a fresh `git clone`
#                                  into a temp dir, then this same script)
#
# Running the SAME file in all three places is the point: "the gate passed" then
# means one thing no matter who says it.
#
# It reports EVERY failure rather than stopping at the first, so one run tells
# you everything that is wrong.
#
# Adapted from AI-DEV-STARTER's templates/deno/gate.sh for THIS repository. One
# deliberate difference, from a measurement of the tree it runs on and recorded
# in INCIDENTS.md — read that file before "fixing" it:
#
#   - format tolerates a file that was ALREADY unformatted at HEAD (web/*.html,
#     web/app.js and several api/*.ts arrived that way); a file this branch
#     breaks still fails.
#
# Lint is deliberately NOT in that list any more. It used to be a ratchet that
# excused 21 pre-existing problems; the backlog was cleared on 2026-09-20 and the
# ratchet was deleted in the same commit. Lint is absolute now — see INCIDENTS.md.
#
# Bypass deliberately, never accidentally:  git commit --no-verify / git push --no-verify
#
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.deno/bin:$PATH"
# No colour: the gate greps its own tools' output, and ANSI escapes defeat both
# the greps here and any log this is piped into.
export NO_COLOR=1
export DENO_NO_UPDATE_CHECK=1

# The artifact-identity pair: the build number, in its two copies.
VERSION_FILE=${VERSION_FILE:-web/version.js}

status=0
step() { printf '\n== %s\n' "$1"; }
note() { printf '   %s\n' "$1"; }
fail() { printf 'GATE FAILED: %s\n' "$1" >&2; status=1; }

# ---------------------------------------------------------------- 0. env
# Deno is the runtime: it is the tool that IS the job here, so its absence is a
# failure, not a skip. A machine with no Deno can certify nothing about this repo.
step "env"
if ! command -v deno >/dev/null 2>&1; then
  fail "deno not found on PATH (expected \$HOME/.deno/bin/deno)"
  printf '\nGATE FAILED - do not push this\n' >&2
  exit 1
fi
note "$(deno --version | head -1)"

# ------------------------------------------- the files this branch touches
# Used by the lint, format and version-bump stages. The repo has pre-existing
# drift, and reporting on the whole tree every run buries the signal in noise
# nobody edited.
if git rev-parse --verify -q HEAD >/dev/null 2>&1; then
  base="$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD)"
  touched="$(
    { git diff --name-only --diff-filter=ACMR "$base" HEAD
      git diff --name-only --diff-filter=ACMR HEAD
      # New files are invisible to `git diff` until they are staged, so without
      # this line a brand-new file is never checked at the moment it is written.
      git ls-files --others --exclude-standard
    } | sort -u
  )"
  # A clean checkout (the nightly job, or any clone level with origin/main) is
  # not "ahead of" anything, so the diffs above are empty and the checks would
  # silently pass on files nobody looked at. Fall back to the last commit.
  if [ -z "$touched" ]; then
    touched="$(git show --name-only --pretty=format: HEAD | sed '/^$/d')"
    late_note=" (last commit, since this checkout is level with origin/main)"
  fi
else
  touched="$(git diff --cached --name-only --diff-filter=ACMR)"
  late_note=" (first commit)"
fi
note "$(printf '%s\n' "$touched" | grep -c .) file(s) in this change"

# ---------------------------------------------------------------- 1. lint
# Absolute: the whole tree, every rule the declared rule set enables, no
# baseline and no exceptions. The tree arrived with 21 pre-existing problems in
# 13 files and this stage used to be a ratchet (it failed only on a violation a
# file did NOT already have at HEAD). The backlog was cleared on 2026-09-20 and
# the ratchet went with it: a stage that tolerates "21 known problems" is one
# everyone learns to ignore, and 40 lines of per-file HEAD comparison is a lot of
# bash to keep once the tree has none. See INCIDENTS.md.
step "lint"
lint_out="$(deno task lint 2>&1)"; lint_rc=$?
if [ "$lint_rc" -eq 0 ]; then
  printf '%s\n' "$lint_out" | grep -E "Checked [0-9]+ files|Found 0 problems" || note "clean"
elif [ -z "$(printf '%s\n' "$lint_out" | sed -n 's/^ *--> *//p')" ]; then
  # No file was named, so this is a config or syntax error rather than a rule
  # violation — a tree that cannot be linted at all is worse than a dirty one.
  printf '%s\n' "$lint_out" | head -20
  fail "deno task lint failed without naming a file (a config or syntax error — the output above)"
else
  printf '%s\n' "$lint_out" | sed -n 's/^ *--> *//p' | sed "s|^$PWD/||" | sort -u | sed 's/^/   /'
  fail "deno task lint ($(printf '%s\n' "$lint_out" | grep -c '^error\[') problem(s), every one of them a failure; full output: deno task lint"
fi

# ---------------------------------------------------------------- 2. tests
# The suite is not only pure functions: it holds the wire contracts (client URL
# vs server route, response envelope, artifact identity) — the checks that catch
# a component/API mismatch no pure-function test can see.
# A green gate on a suite that ran nothing is theatre, so the count is checked.
step "tests"
test_out="$(deno task test 2>&1)"; test_rc=$?
if [ "$test_rc" -ne 0 ]; then
  printf '%s\n' "$test_out" | grep -E "FAILED|error:|AssertionError|Diff|SKIPPED" | head -40
  fail "deno task test (failures above; full output: deno task test)"
else
  passed="$(printf '%s\n' "$test_out" | sed -n 's/.*| \([0-9][0-9]*\) passed.*/\1/p' | tail -1)"
  printf '%s\n' "$test_out" | grep -E "^ok \|" | tail -1 || true
  printf '%s\n' "$test_out" | grep -E "SKIPPED" || true
  if [ -z "$passed" ]; then
    fail "the test stage produced no result line — cannot certify the suite ran"
  elif [ "$passed" -lt 10 ]; then
    fail "only $passed test(s) ran — a gate this green is not checking anything"
  elif [ -z "${DATABASE_URL:-}" ]; then
    note "the live HTTP envelope check SKIPPED (no DATABASE_URL) — to include it: export DATABASE_URL=... (tests/deno/api_live_test.ts)"
  fi
fi

# ---------------------------------------------------------------- 3. format
# Only the files this branch touches, and only the drift this branch introduces:
# a file that was already unformatted at HEAD is not this change's problem, but
# one it breaks is.
files="$(printf '%s\n' "$touched" | grep -E '\.(js|ts|css|html|json|jsonc|md)$' || true)"
step "format ($(printf '%s\n' "$files" | grep -c . ) file(s) in this change)"
if [ -z "$files" ]; then
  note "nothing to check"
else
  tmpdir="$(mktemp -d)"
  fmt_bad=""
  for f in $files; do
    if deno fmt --check "$f" >/dev/null 2>&1; then continue; fi
    if git cat-file -e "HEAD:$f" 2>/dev/null; then
      at_head="$tmpdir/$(basename "$f")"
      if git show "HEAD:$f" >"$at_head" 2>/dev/null && ! deno fmt --check "$at_head" >/dev/null 2>&1; then
        note "pre-existing drift, not yours: $f"
        continue
      fi
    fi
    fmt_bad="$fmt_bad $f"
  done
  rm -rf "$tmpdir"
  if [ -n "$fmt_bad" ]; then
    fail "deno fmt --check on files this branch made unformatted:$fmt_bad (fix: deno fmt$fmt_bad)"
  fi
fi

# ---------------------------------------------------------------- 4. artifact identity
# Two copies of one number: APP_VERSION in web/version.js and the `?v=` on the
# asset references in web/*.html. If they disagree, a browser holding the old
# asset keeps serving last week's build — the deploy looks green and is
# invisible. (Verified: Oak's send() ignores the query string, so /app.js?v=...
# serves the same bytes as /app.js.)
step "artifact identity ($VERSION_FILE <-> the ?v= in web/*.html)"
if [ ! -f "$VERSION_FILE" ]; then
  fail "$VERSION_FILE is missing — it is the single source of truth for the build number"
else
  app_version="$(sed -n 's/.*APP_VERSION *= *"\([^"]*\)".*/\1/p' "$VERSION_FILE" | head -1)"
  refs="$(grep -ho '?v=[^"&]*' web/*.html 2>/dev/null | sed 's/^?v=//' | sort -u || true)"
  # Every local asset reference, versioned or not, minus the versioned ones: what
  # is left is a page loading /styles.css or /email.js bare. Restricted to
  # /-rooted .css/.js so page links and external URLs are not asked for a version
  # they cannot have. (The four static pages shipped unversioned until 2026-09-20.)
  unversioned="$(
    grep -HoE '(src|href)="/[^"]*\.(css|js)(\?[^"]*)?"' web/*.html 2>/dev/null |
      grep -v '?v=' | sed 's/^/   /' || true
  )"
  if [ -z "$app_version" ]; then
    fail "could not read APP_VERSION from $VERSION_FILE (the sed expects: export const APP_VERSION = \"x.y.z\";)"
  elif [ -z "$refs" ]; then
    fail "no versioned asset reference (?v=) in web/*.html — the pair is not wired to the browser"
  else
    mismatch="$(printf '%s\n' "$refs" | grep -vx "$app_version" || true)"
    if [ -n "$mismatch" ]; then
      printf '%s\n' "$mismatch" | sed 's/^/   ?v=/'
      fail "web/*.html says ?v=$(printf '%s' "$mismatch" | tr '\n' ' ') but $VERSION_FILE says $app_version (bump both, from the same edit)"
    fi
    if [ -n "$unversioned" ]; then
      printf '%s\n' "$unversioned"
      fail "unversioned asset reference(s) above — every local .css/.js a page loads must carry ?v=$app_version, or that page keeps serving last week's file out of the browser cache"
    fi
    if [ -z "$mismatch" ] && [ -z "$unversioned" ]; then
      note "$VERSION_FILE == web/*.html ?v= == $app_version ($(
        grep -ho '?v=[^"&]*' web/*.html | grep -c .
      ) reference(s) over $(ls web/*.html | wc -l | tr -d ' ') page(s), none unversioned)"
    fi
  fi
fi

# A web/ change without a version bump is a deploy that stays invisible on a
# browser that has the asset cached. The identity check above keeps the two
# copies honest; this keeps the bump from being forgotten in the first place.
changed_web="$(printf '%s\n' "$touched" | grep '^web/' | grep -vx "$VERSION_FILE" || true)"
if [ -z "$changed_web" ]; then
  note "no web/ changes (or only $VERSION_FILE)"
else
  if printf '%s\n' "$touched" | grep -qx "$VERSION_FILE"; then
    note "web/ changed, and $VERSION_FILE was bumped"
  else
    printf '%s\n' "$changed_web" | sed 's/^/   touched: /'
    fail "web/ changed without bumping $VERSION_FILE (and the ?v= in web/*.html)"
  fi
fi

# ---------------------------------------------------------------- 5. kit probes
# A fix that must propagate ships a probe (docs/KIT-REVISION-CONVENTION.md). Each script in
# tools/kit-probes/ holds this gate to ONE kit fix's contract — name and behaviour, not
# bytes — and exits non-zero when the fix is absent: offline, no kit checkout, no build, <1 s.
# The directory IS the list of fixes this copy claims to carry, so absence fails here instead
# of sitting in prose. A missing directory is not a failure: it means this copy carries no
# probe yet.
step "kit probes (the fixes this copy claims to carry)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
if [ ! -d tools/kit-probes ]; then
  echo "  no tools/kit-probes/ — this copy carries no kit probe yet"
else
  for probe in tools/kit-probes/*.sh; do
    [ -f "$probe" ] || continue
    if bash "$probe" "$self" "$PWD"; then
      echo "  ok   $(basename "$probe")"
    else
      fail "$(basename "$probe") — this copy is behind that kit fix (see tools/kit-probes/)"
    fi
  done
fi


if [ "$status" -eq 0 ]; then
  printf '\nGATE PASSED%s\n' "${late_note:-}"
else
  printf '\nGATE FAILED - do not push this\n' >&2
fi

exit "$status"
