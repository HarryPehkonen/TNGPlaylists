#!/usr/bin/env bash
#
# env — Deno is the runtime: it is the tool that IS the job here, so its absence is a
# failure, not a skip. A machine with no Deno can certify nothing about this repo.
#
# Called from gate.toml as `[stage.env] cmd = "scripts/env.sh"`.
set -uo pipefail
. "$(dirname "$0")/gate-env.sh"

run_stage() {
    if ! command -v deno >/dev/null 2>&1; then
        fail "deno not found on PATH (expected \$HOME/.deno/bin/deno)"
    fi
    note "$(deno --version | head -1)"
}

run_stage "$@"
