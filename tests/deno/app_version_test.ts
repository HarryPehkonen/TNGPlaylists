/**
 * The artifact-identity invariant, as a test: one build number, two copies.
 * See app_version.ts for what the pair is and why this repo needs it.
 *
 * The gate's artifact-identity stage checks the same pair (with grep, so it also
 * catches "web/ changed without bumping version.js", which needs the diff and a
 * test cannot see). This file is the half that runs everywhere the tests run.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { appVersion, assetRefs, isLocalAsset, refVersion } from "./app_version.ts";
import { htmlFiles, read } from "./repo.ts";

const versionSource = await read("web/version.js");
const declared = appVersion(versionSource);

const pages: Array<{ file: string; html: string }> = [];
for (const file of await htmlFiles()) {
  pages.push({ file, html: await read(file) });
}

/** Every versioned reference in the repo, as `file -> ref`. */
const versioned = pages.flatMap(({ file, html }) =>
  assetRefs(html)
    .map((ref) => ({ file, ref, version: refVersion(ref) }))
    .filter((entry) => entry.version !== null)
) as Array<{ file: string; ref: string; version: string }>;

/** Negative case: the extractors must not pass by finding nothing. */
Deno.test("version: the pair is readable at all (a broken extractor fails loudly)", () => {
  assert(declared, `web/version.js declares no APP_VERSION: ${versionSource.slice(0, 60)}`);
  assert(pages.length >= 5, `expected 5+ html pages, found ${pages.length}`);
  assert(
    versioned.length >= 2,
    `expected 2+ versioned asset references, found ${versioned.length}`,
  );
});

Deno.test("version: every `?v=` in web/*.html equals APP_VERSION", () => {
  const declaredVersions = versioned.filter((v) => v.version !== declared);
  assertEquals(
    declaredVersions.map((v) => `${v.file}: ${v.ref}`),
    [],
    `web/version.js says ${declared}`,
  );
});

Deno.test("version: every local asset reference in web/*.html carries the build number", () => {
  // The pages are enumerated from disk (repo.ts) and the asset shape from the
  // reference, so a NEW page cannot arrive unversioned without failing here.
  const unversioned = pages.flatMap(({ file, html }) =>
    assetRefs(html)
      .filter((ref) => isLocalAsset(ref) && refVersion(ref) === null)
      .map((ref) => `${file}: ${ref}`)
  );
  assertEquals(
    unversioned,
    [],
    `every local .css/.js a page loads must carry ?v=${declared}, or that page keeps ` +
      `serving last week's file out of the browser cache`,
  );

  // Non-vacuity: the rule above passes trivially if nothing counts as a local
  // asset, which is exactly how a "the assets are versioned" rule goes quiet.
  const local = pages.flatMap(({ html }) => assetRefs(html).filter(isLocalAsset));
  assert(local.length >= 10, `expected 10+ local asset references, found ${local.length}`);
});

Deno.test("version: the local-asset rule fires on that shape and only that shape", () => {
  assert(isLocalAsset("/styles.css"), "a bare stylesheet link is a local asset");
  assert(isLocalAsset("/email.js?v=1.0.0"), "a versioned one is too");
  assert(!isLocalAsset("/about.html"), "a page navigation is not an asset");
  assert(!isLocalAsset("https://deno.com"), "an external URL is not a local asset");
  assert(!isLocalAsset("styles.css"), "an unprefixed path is not served from the root");

  // The failure this rule exists for: a page that loads /styles.css bare. The
  // synthetic case proves the checker can fail, which the repo half cannot.
  const refs = assetRefs(`<link rel="stylesheet" href="/styles.css">`);
  assertEquals(refs, ["/styles.css"]);
  assertEquals(
    refs.filter((ref) => isLocalAsset(ref) && refVersion(ref) === null),
    ["/styles.css"],
    "a bare asset reference must be caught, not skipped",
  );
});

Deno.test("version: the app entry point's two assets are versioned by name", () => {
  const index = pages.find((p) => p.file === "web/index.html");
  assert(index, "web/index.html is missing");
  const refs = assetRefs(index.html);

  // Named deliberately: these two are the files that run the application, and an
  // unversioned /app.js is the deploy that stays invisible on a cached browser.
  for (const asset of ["/app.js", "/styles.css"]) {
    const ref = refs.find((r) => r.split("?")[0] === asset);
    assert(ref, `web/index.html no longer references ${asset}`);
    assertEquals(refVersion(ref!), declared, `${asset} is not versioned at ${declared}`);
  }
});

Deno.test("version: the bump rule is documented where it is enforced", () => {
  // The gate stage and this file both name web/version.js as the thing to bump.
  // If someone moves the file, this test says so before a stale deploy does.
  assertStringIncludes(versionSource, "export const APP_VERSION");
  assertStringIncludes(versionSource, "web/index.html");
});
