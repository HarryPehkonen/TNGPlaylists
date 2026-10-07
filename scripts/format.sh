#!/usr/bin/env bash
#
# format — the files this branch touches, and only the drift this branch INTRODUCES: a file
# that was already unformatted at HEAD (web/*.html, web/app.js and several api/*.ts arrived
# that way — the measurement is in INCIDENTS.md) is not this change's problem, but one it
# breaks is. The staged copy is checked too: the check above reads the WORKING TREE and a
# commit records the INDEX, so a file staged unformatted and then formatted on disk would
# otherwise pass while the commit records the unformatted text (kit fix
# `format-checks-staged-deno`, docs/KIT-FIXES.md, kit 9e73c6c).
#
# The staged copy is checked the same way — on a FILE, never on stdin: `deno fmt --check`
# resolves deno.json (lineWidth 100 here) from the directory it runs in, and formatting a
# stdin stream does NOT — measured 2026-10-06, a 90-column line passes in file mode and is
# rewrapped by `deno fmt --ext md -`, so a stdin test would refuse files this project's own
# options call formatted.
#
# Called from gate.toml as `[stage.format] cmd = "scripts/format.sh"`.
set -uo pipefail
. "$(dirname "$0")/gate-env.sh"

run_stage() {
    local touched files tmpdir fmt_bad f at_head staged_bad staged sf blob headblob
    touched="$(touched_files)"
    files="$(printf '%s\n' "$touched" | grep -E '\.(js|ts|css|html|json|jsonc|md)$' || true)"
    if [ -z "$files" ]; then
        note "nothing to check"
        return 0
    fi

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
    done  # working-tree half; $tmpdir stays up for the staged half
    if [ -n "$fmt_bad" ]; then
        fail "deno fmt --check on files this branch made unformatted:$fmt_bad (fix: deno fmt$fmt_bad)"
    fi

    staged_bad=""
    staged="$(git diff --cached --name-only --diff-filter=ACMR \
        | grep -E '\.(js|ts|css|html|json|jsonc|md)$' || true)"
    for sf in $staged; do
        blob="$tmpdir/$(basename "$sf")"
        git show ":$sf" > "$blob" 2>/dev/null || continue
        deno fmt --check "$blob" >/dev/null 2>&1 && continue
        # This gate's own rule, on the staged side: drift already at HEAD is not this change's
        # problem. Without it the staged check was STRICTER than the working-tree check above —
        # measured 2026-10-06, when this repo's own INCIDENTS.md entry (an edit to a file
        # already unformatted at HEAD) was refused a commit by this stage.
        headblob="$tmpdir/head-$(basename "$sf")"
        if git show "HEAD:$sf" > "$headblob" 2>/dev/null \
           && ! deno fmt --check "$headblob" >/dev/null 2>&1; then
            note "pre-existing drift, not yours (staged copy): $sf"
            continue
        fi
        staged_bad="$staged_bad $sf"
    done
    rm -rf "$tmpdir"
    if [ -n "$staged_bad" ]; then
        printf '    the STAGED copy is not formatted (that is what a commit would record):\n'
        for sf in $staged_bad; do printf '      %s\n' "$sf"; done
        fail "deno fmt on the STAGED copy (fix: deno fmt$staged_bad && git add$staged_bad)"
    fi
}

run_stage "$@"
