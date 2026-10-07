#!/usr/bin/env bash
#
# tests — the suite is not only pure functions: it holds the wire contracts (client URL vs
# server route, response envelope, artifact identity) — the checks that catch a component/API
# mismatch no pure-function test can see. A green gate on a suite that ran nothing is theatre,
# so the count is checked, and so is the live HTTP envelope check's absence.
#
# Called from gate.toml as `[stage.tests] cmd = "scripts/tests.sh"`.
set -uo pipefail
. "$(dirname "$0")/gate-env.sh"

run_stage() {
    local test_out test_rc passed
    test_out="$(deno task test 2>&1)"; test_rc=$?
    if [ "$test_rc" -ne 0 ]; then
        printf '%s\n' "$test_out" | grep -E "FAILED|error:|AssertionError|Diff|SKIPPED" | head -40
        fail "deno task test (failures above; full output: deno task test)"
    fi
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
}

run_stage "$@"
