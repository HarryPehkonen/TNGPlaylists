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
 * Both halves are checked over EVERY page under web/, not just the entry point.
 * Until 2026-09-20 the four static pages (about/privacy/terms/copyright) loaded
 * /styles.css and /email.js unversioned — the same stale-asset bug one page over,
 * where a stylesheet change ships and the visitor keeps the old sheet. The rule
 * is "every local asset reference carries the number"; `isLocalAsset()` is what
 * makes it checkable, and the pages are enumerated from disk, never listed.
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

/**
 * Is this reference a local asset the browser caches — a `/`-rooted `.css` or
 * `.js`? Page navigations (`/about.html`) and external URLs (`https://…`) are
 * deliberately not, because they cannot carry a build number that means anything.
 */
export function isLocalAsset(ref: string): boolean {
  return /^\/.*\.(css|js)(\?|$)/.test(ref);
}

/** The APP_VERSION literal declared in web/version.js. */
export function appVersion(source: string): string | null {
  const match = source.match(/export\s+const\s+APP_VERSION\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}
