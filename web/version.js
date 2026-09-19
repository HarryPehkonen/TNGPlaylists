/**
 * The client build number — the single source of truth for "which build is this?".
 *
 * Bump APP_VERSION in the same edit that changes anything under web/, and bump the
 * `?v=` query on the asset references in web/index.html to match. An unversioned
 * asset URL is a deploy that stays invisible on a browser holding the old file in
 * its cache: the server says 200 (or 304), the phone runs last week's app.js, and
 * nothing anywhere looks wrong.
 *
 * Enforced by:
 *   - the artifact-identity stage of scripts/gate.sh (APP_VERSION vs every ?v= in web/*.html,
 *     plus "web/ changed without bumping this file")
 *   - tests/deno/app_version_test.ts (same pair, as a test the gate's test stage runs)
 *
 * Why here and not in index.html: the HTML carries the copy the browser actually
 * caches under, so it has to be a literal; this file is the copy a human (or agent)
 * reads, lints, and diffs. Two copies, one number.
 */
export const APP_VERSION = "1.0.0";
