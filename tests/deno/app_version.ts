/**
 * The artifact-identity pair: one build number, two copies, enforced.
 *
 * TNGPlaylists has no service worker and no build step, so the number that goes
 * stale here is the asset URL itself. The browser caches /styles.css and /app.js
 * under whatever URL it was given; a deploy that changes those files but not the
 * URL leaves every returning visitor running last week's app until they clear
 * their cache by hand — and nothing anywhere looks wrong: the server says 200,
 * the logs are clean, and the bug report is "the button moved back".
 *
 * So the pair is:
 *   - web/version.js  APP_VERSION — the copy a human (or an agent) reads, lints
 *     and diffs; the single source of truth
 *   - the `?v=` query on the asset references in web/index.html — the copy the
 *     browser actually caches under (verified: Oak's send() ignores the query
 *     string and serves the same bytes for /app.js and /app.js?v=1.0.0)
 *
 * They must agree. Enforced by the artifact-identity stage of scripts/gate.sh
 * (which also fails when web/ changes without web/version.js changing) and by
 * app_version_test.ts, so the gate's test stage catches it too.
 *
 * Deliberately narrow for now: only web/index.html carries versioned asset
 * references. The four static pages (about/privacy/terms/copyright) still load
 * /styles.css and /email.js unversioned; the check below picks up any `?v=`
 * they gain automatically, so versioning them later needs no change here.
 */

/** Every asset reference in an HTML file: `<link href>` / `<script src>`. */
export function assetRefs(html: string): string[] {
  const refs: string[] = [];
  for (const match of html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"]+)"/g)) {
    refs.push(match[1]);
  }
  return refs;
}

/** The version query of a reference, or null when it carries none. */
export function refVersion(ref: string): string | null {
  const match = ref.match(/[?&]v=([^&"]+)/);
  return match ? match[1] : null;
}

/** The APP_VERSION literal declared in web/version.js. */
export function appVersion(source: string): string | null {
  const match = source.match(/export\s+const\s+APP_VERSION\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}
