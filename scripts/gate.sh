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
# Adapted from AI-DEV-STARTER's templates/deno/gate.sh for THIS repository. Two
# deliberate differences, both from measurements of the tree it runs on, both
# recorded in INCIDENTS.md — read that file before "fixing" either one:
#
#   - lint is a ratchet: the whole tree is linted, but only a violation a file
#     did NOT have at HEAD fails the gate. The tree arrived with 21 pre-existing
#     lint problems in 13 files, and a gate that blocks every change which
#     happens to open one of them is a gate people learn to bypass.
#   - format tolerates a file that was ALREADY unformatted at HEAD (web/*.html
#     arrived that way); a file this branch breaks still fails.
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
# Whole tree, attributed per file AND per violation: a file this branch touches
# is linted as a whole, but only the violations it did NOT have at HEAD fail the
# gate (a ratchet, the same idea as the format stage below). The tree arrived
# with 21 problems in 13 files; blocking every change that happens to open one of
# those files is how a gate teaches people to type --no-verify.
step "lint"
lint_out="$(deno task lint 2>&1)"; lint_rc=$?
lint_files="$(
  printf '%s\n' "$lint_out" | sed -n 's/^ *--> *//p' | sed 's/:[0-9]*:[0-9]*$//' |
    sed "s|^$PWD/||" | sort -u
)"
count_in() { # count_in <file> <lint output>
  printf '%s\n' "$2" | grep -cE "^ *--> *(.*/)?$1(:[0-9]+:[0-9]+)?$" || true
}
if [ "$lint_rc" -eq 0 ]; then
  printf '%s\n' "$lint_out" | grep -E "Checked [0-9]+ files|Found 0 problems" || note "clean"
elif [ -z "$lint_files" ]; then
  printf '%s\n' "$lint_out" | head -20
  fail "deno task lint failed without naming a file (a config or syntax error — the output above)"
else
  mine="$(printf '%s\n' "$lint_files" | grep -Fxf <(printf '%s\n' "$touched") || true)"
  if [ -z "$mine" ]; then
    note "not mine: $(printf '%s\n' "$lint_out" | grep -c '^error\[') pre-existing problem(s) in $(
      printf '%s\n' "$lint_files" | grep -c .
    ) file(s) this branch does not touch (see INCIDENTS.md)"
  else
    tmpdir="$(mktemp -d)"
    new_violations=""
    for f in $mine; do
      now="$(count_in "$f" "$lint_out")"
      was=0
      if git cat-file -e "HEAD:$f" 2>/dev/null; then
        # Lint the file as HEAD had it; its violations are not this branch's.
        head_copy="$tmpdir/$(basename "$f")"
        git show "HEAD:$f" >"$head_copy" 2>/dev/null
        was="$(count_in "$(basename "$f")" "$(deno lint "$head_copy" 2>&1)")"
      fi
      if [ "$now" -gt "$was" ]; then
        new_violations="$new_violations $f($was->$now)"
        printf '%s\n' "$lint_out" | grep -A1 -E "^ *--> *(.*/)?$f(:[0-9]+:[0-9]+)?$" | head -20
      fi
    done
    rm -rf "$tmpdir"
    if [ -n "$new_violations" ]; then
      fail "deno lint found new problems in:$new_violations (was->now; fix them, or make the same fix at HEAD first)"
    else
      note "no new lint problems in the $(printf '%s\n' "$mine" | grep -c .) file(s) this branch touches ($(printf '%s\n' "$lint_out" | grep -c '^error\[') pre-existing in the tree)"
    fi
  fi
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
  if [ -z "$app_version" ]; then
    fail "could not read APP_VERSION from $VERSION_FILE (the sed expects: export const APP_VERSION = \"x.y.z\";)"
  elif [ -z "$refs" ]; then
    fail "no versioned asset reference (?v=) in web/*.html — the pair is not wired to the browser"
  else
    mismatch="$(printf '%s\n' "$refs" | grep -vx "$app_version" || true)"
    if [ -n "$mismatch" ]; then
      printf '%s\n' "$mismatch" | sed 's/^/   ?v=/'
      fail "web/*.html says ?v=$(printf '%s' "$mismatch" | tr '\n' ' ') but $VERSION_FILE says $app_version (bump both, from the same edit)"
    else
      note "$VERSION_FILE == web/*.html ?v= == $app_version ($(
        grep -ho '?v=[^"&]*' web/*.html | grep -c .
      ) reference(s))"
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

if [ "$status" -eq 0 ]; then
  printf '\nGATE PASSED%s\n' "${late_note:-}"
else
  printf '\nGATE FAILED - do not push this\n' >&2
fi

exit "$status"
