#!/usr/bin/env bash
#
# TNGPlaylists' gate: the configuration every stage reads, and the helpers they share.
#
# The POLICY is gate.toml (which stages exist, which tier runs which of them, how a failure
# is recognised). The ENGINE is kit-ci, one binary installed once per machine
# (cmake -S ~/hermes-workspace/KitCI -B build && cmake --install build --prefix ~/.local).
# Everything a stage needs BEYOND that policy - the Deno on PATH, the version file, the
# touched-file list - lives HERE, so the policy file stays a list of stages.
#
# SOURCED, never executed: scripts/gate.sh does not need it; every stage script does
# (`. "$(dirname "$0")/gate-env.sh"`). Until 2026-10-06 this was the prologue of a 282-line
# scripts/gate.sh, which ran every check itself and printed its own summary (card
# t_075c0a6f). The knobs are the ones that script carried, with the defaults it had.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
export PATH="$HOME/.deno/bin:$PATH"
# No colour: the gate greps its own tools' output, and ANSI escapes defeat both the greps
# here and any log it is piped into.
export NO_COLOR=1
export DENO_NO_UPDATE_CHECK=1

# The artifact-identity pair: the build number, in its two copies.
VERSION_FILE=${VERSION_FILE:-web/version.js}

if [ -f .ci.env ]; then
    # shellcheck disable=SC1091
    . ./.ci.env
fi

# A stage's verdict is its exit status now, so the old gate's status/step/fail trio is one
# helper: `fail` says why and exits 1, and kit-ci names the stage in its own verdict line.
fail() { printf 'GATE FAILED: %s\n' "$*" >&2; exit 1; }
note() { printf '   %s\n' "$*"; }

# The files this branch touches — used by the format and version stages. The repo has
# pre-existing drift, and reporting on the whole tree every run buries the signal in noise
# nobody edited. A clean checkout (the nightly job, or any clone level with origin/main) is
# not "ahead of" anything, so the diffs are empty there and the LAST COMMIT is what is
# checked instead: on a daily cadence that is "what went in yesterday".
touched_files() {
    local base touched
    if git rev-parse --verify -q HEAD >/dev/null 2>&1; then
        base="$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD)"
        touched="$(
            { git diff --name-only --diff-filter=ACMR "$base" HEAD
              git diff --name-only --diff-filter=ACMR HEAD
              # `git diff HEAD` compares the WORKING TREE and skips the index, so a file whose
              # staged copy differs from its working-tree copy (staged, then formatted on disk)
              # appeared in neither it nor the untracked list.
              git diff --cached --name-only --diff-filter=ACMR
              # New files are invisible to `git diff` until they are staged, so without this
              # line a brand-new file is never checked at the moment it is written.
              git ls-files --others --exclude-standard
            } | sort -u
        )"
        if [ -z "$touched" ]; then
            touched="$(git show --name-only --pretty=format: HEAD | sed '/^$/d')"
        fi
    else
        touched="$(git diff --cached --name-only --diff-filter=ACMR)"
    fi
    printf '%s\n' "$touched"
}
