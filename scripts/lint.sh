#!/usr/bin/env bash
#
# lint — absolute: the whole tree, every rule the declared rule set enables, no baseline and
# no exceptions. The tree arrived with 21 pre-existing problems in 13 files and this check
# used to be a ratchet (it failed only on a violation a file did NOT already have); the
# backlog was cleared on 2026-09-20 and the ratchet went with it. A stage that tolerates "21
# known problems" is one everyone learns to ignore, and 40 lines of per-file HEAD comparison
# is a lot of bash to keep once the tree has none. See INCIDENTS.md.
#
# Called from gate.toml as `[stage.lint] cmd = "scripts/lint.sh"`.
set -uo pipefail
. "$(dirname "$0")/gate-env.sh"

run_stage() {
    local lint_out lint_rc
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
}

run_stage "$@"
