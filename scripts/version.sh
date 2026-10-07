#!/usr/bin/env bash
#
# version — the artifact-identity pair: two copies of one number, APP_VERSION in
# web/version.js and the `?v=` on the asset references in web/*.html. If they disagree, a
# browser holding the old asset keeps serving last week's build — the deploy looks green and
# is invisible. (Verified: Oak's send() ignores the query string, so /app.js?v=... serves the
# same bytes as /app.js.) The second half keeps the BUMP from being forgotten: a web/ change
# without one is a deploy that stays invisible on a browser that has the asset cached.
#
# Called from gate.toml as `[stage.version] cmd = "scripts/version.sh"`.
set -uo pipefail
. "$(dirname "$0")/gate-env.sh"

run_stage() {
    local touched app_version refs unversioned mismatch changed_web
    if [ ! -f "$VERSION_FILE" ]; then
        fail "$VERSION_FILE is missing — it is the single source of truth for the build number"
    fi

    app_version="$(sed -n 's/.*APP_VERSION *= *"\([^"]*\)".*/\1/p' "$VERSION_FILE" | head -1)"
    refs="$(grep -ho '?v=[^"&]*' web/*.html 2>/dev/null | sed 's/^?v=//' | sort -u || true)"
    # Every local asset reference, versioned or not, minus the versioned ones: what is left is
    # a page loading /styles.css or /email.js bare. Restricted to /-rooted .css/.js so page
    # links and external URLs are not asked for a version they cannot have. (The four static
    # pages shipped unversioned until 2026-09-20.)
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

    touched="$(touched_files)"
    changed_web="$(printf '%s\n' "$touched" | grep '^web/' | grep -vx "$VERSION_FILE" || true)"
    if [ -z "$changed_web" ]; then
        note "no web/ changes (or only $VERSION_FILE)"
    elif printf '%s\n' "$touched" | grep -qx "$VERSION_FILE"; then
        note "web/ changed, and $VERSION_FILE was bumped"
    else
        printf '%s\n' "$changed_web" | sed 's/^/   touched: /'
        fail "web/ changed without bumping $VERSION_FILE (and the ?v= in web/*.html)"
    fi
}

run_stage "$@"
