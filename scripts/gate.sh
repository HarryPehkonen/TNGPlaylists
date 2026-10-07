#!/usr/bin/env bash
#
# The gate — run this before you commit, and before you push (and before deploy).
#
# The POLICY is gate.toml (the stages, their tiers, their failure rules). The ENGINE is
# kit-ci, one binary installed once per machine:
#
#     cmake -S ~/hermes-workspace/KitCI -B build && cmake --build build
#     cmake --install build --prefix ~/.local        # -> ~/.local/bin/kit-ci
#
# This file is what all three callers run, so "the gate passed" means one thing no matter who
# says it:
#
#   1. a human, by hand            scripts/gate.sh [--tier fast]
#   2. git, on commit and on push  .githooks/pre-commit and .githooks/pre-push, which NAME
#                                  the tier (arm once per clone: git config core.hooksPath .githooks)
#   3. a clean checkout elsewhere  the Pi's nightly job: a fresh `git clone` into a temp dir,
#                                  then this same script
#
# Changing the gate means editing gate.toml, not this file. Until 2026-10-06 this file WAS
# the gate: 282 lines of bash, five steps, its own summary (card t_075c0a6f). The checks are
# now gate.toml plus the scripts in this directory, and the knobs that script read live in
# scripts/gate-env.sh.
#
# Every check is seconds, so no tier is cheaper than another here; the two tiers exist so a
# stage added to gate.toml cannot be run by one caller and forgotten by the other.
#
# Bypass deliberately, never accidentally:  git commit --no-verify / git push --no-verify
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# A gate that cannot find its engine must fail loudly rather than read as green.
if ! command -v kit-ci >/dev/null 2>&1; then
    printf 'gate: kit-ci is not installed. Build KitCI, then: cmake --install build --prefix ~/.local\n' >&2
    exit 1
fi

# No arguments: the tier the caller names (GATE_TIER, the variable the old gate honoured,
# still works) and otherwise the full tier — what a human running the gate by hand wants.
[ "$#" -gt 0 ] && exec kit-ci "$@"
exec kit-ci --tier "${GATE_TIER:-full}"
