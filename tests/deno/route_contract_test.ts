/**
 * The URL contract between the browser and the server, checked by reading the
 * sources (see route_contract.ts for why).
 *
 * Two halves:
 *   - synthetic tests: do the extractors and the matcher behave, and can the
 *     checker FAIL? (a guard that has never failed is a guess)
 *   - the real repository: every call site in web/ resolves to a route api/
 *     actually serves, and the extraction is not vacuous.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { clientFiles, read, serverSources } from "./repo.ts";
import {
  apiPrefix,
  checkContract,
  clientCalls,
  declaredRoutes,
  importedModules,
  mountedRouters,
  normalizePath,
  routeMatches,
  serverRoutes,
} from "./route_contract.ts";

// ---------------------------------------------------------------- extractors

Deno.test("normalizePath: a query string is dropped, whatever built it", () => {
  assertEquals(normalizePath("/search?q=${encodeURIComponent(query)}&limit=50"), "/search");
  assertEquals(normalizePath("/search/suggestions?q=x&limit=10"), "/search/suggestions");
});

Deno.test("normalizePath: each ${...} becomes one opaque segment", () => {
  assertEquals(normalizePath("/episodes/${id}"), "/episodes/:param");
  assertEquals(
    normalizePath("/playlists/${playlistId}/episodes/${episodeId}"),
    "/playlists/:param/episodes/:param",
  );
});

Deno.test("normalizePath: a trailing expression ends the path (it may hold the query)", () => {
  // How web/app.js builds the keyword filter: the `?category=` lives inside the
  // ${...}, so the readable path is /keywords and nothing more.
  assertEquals(
    normalizePath('/keywords${cat ? `?category=${encodeURIComponent(cat)}` : ""}'),
    "/keywords",
  );
  assertEquals(normalizePath("/search${q ? `?q=${q}` : ''}"), "/search");
});

Deno.test("normalizePath: a bare or odd path still reads as a path", () => {
  assertEquals(normalizePath("/"), "/");
  assertEquals(normalizePath(""), "/");
  assertEquals(normalizePath("watched"), "/watched");
  assertEquals(normalizePath("//watched//x?y"), "/watched/x");
});

Deno.test("clientCalls: the api() helper defaults to GET, options give the method", () => {
  const source = `
    getWatched() { return api("/watched"); },
    save(name) { return api("/playlists", { method: "POST", body: JSON.stringify({ name }) }); },
    remove(id) { return api(\`/playlists/\${id}\`, { method: "DELETE" }); },
  `;
  const { calls, skipped, other, definitions } = clientCalls(source, "synthetic.js");

  assertEquals(calls.map((c) => `${c.method} ${c.path}`), [
    "GET /watched",
    "POST /playlists",
    "DELETE /playlists/:param",
  ]);
  for (const call of calls) assertEquals(call.absolute, false, "api() paths are relative");
  assertEquals([skipped, other, definitions], [0, 0, 0]);
});

Deno.test("clientCalls: one call site, two methods (the watched toggle) yields both", () => {
  // web/app.js really writes this: PUT to mark watched, DELETE to unmark.
  const source = 'await api(`/watched/${id}`, { method: nowWatched ? "PUT" : "DELETE" });';
  const { calls } = clientCalls(source, "synthetic.js");

  assertEquals(calls.map((c) => `${c.method} ${c.path}`).sort(), [
    "DELETE /watched/:param",
    "PUT /watched/:param",
  ]);
});

Deno.test("clientCalls: the helper's own definition is not a call site", () => {
  const source = `async function api(path, options = {}) {
    const resp = await fetch(\`\${API_BASE}\${path}\`, options);
    return resp;
  }`;
  const { calls, skipped, definitions } = clientCalls(source, "synthetic.js");

  assertEquals(definitions, 1, "the definition is counted, not read as a call");
  assertEquals(calls, []);
  assertEquals(skipped, 1, "the helper's own fetch is dynamic and must be counted, not guessed");
});

Deno.test("clientCalls: a path built in a variable is counted, never guessed", () => {
  const source = `
    remove(id) { const url = "/watched/" + id; return api(url, { method: "DELETE" }); },
  `;
  const { calls, skipped } = clientCalls(source, "synthetic.js");

  assertEquals(calls, [], "no literal path is visible at the site");
  assertEquals(skipped, 1, "the site must be reported as dynamic");
});

Deno.test("clientCalls: a plain fetch carries its own /api prefix, a link is a GET", () => {
  const source = `
    const resp = await fetch("/api/auth/me", { method: "DELETE" });
    btn.href = "/api/auth/login";
    const external = await fetch("https://example.com/x");
  `;
  const { calls, other } = clientCalls(source, "synthetic.js");

  assertEquals(calls.map((c) => `${c.method} ${c.absolute ? "abs" : "rel"} ${c.path}`), [
    "DELETE abs /api/auth/me",
    "GET abs /api/auth/login",
  ]);
  assertEquals(calls[1].kind, "navigation");
  assertEquals(other, 1, "an external URL is a literal, but not one of ours");
});

// ------------------------------------------------------------ server routes

Deno.test("routeSites: reads method and path, and binds them to a router variable", () => {
  const source = `
    export const episodesRouter = new Router();
    episodesRouter.get("/api/episodes/:id", async (ctx) => {});
    episodesRouter.delete("/api/watched/:episodeId", requireAuth, async (ctx) => {});
    someOtherThing.get("/api/nope", () => {});
    router.get("/not-a-router", () => {});
  `;
  assertEquals(declaredRoutes(source, "synthetic.ts").map((r) => `${r.method} ${r.pattern}`), [
    "GET /api/episodes/:id",
    "DELETE /api/watched/:episodeId",
  ]);
});

Deno.test("mountedRouters: the prefix (or its absence) comes from the entry point", () => {
  const main = `
    import { episodesRouter } from "./episodes.ts";
    import { tagsRouter } from "./tags.ts";
    app.use(episodesRouter.routes());
    app.use("/api/tags", tagsRouter.routes());
  `;
  assertEquals([...mountedRouters(main)], [["episodesRouter", ""], ["tagsRouter", "/api/tags"]]);
});

Deno.test("serverRoutes: a prefixed mount is composed, an unprefixed one keeps its own path", () => {
  const main = `
    import { episodesRouter } from "./episodes.ts";
    import { tagsRouter } from "./tags.ts";
    app.use(episodesRouter.routes());
    app.use("/api/tags", tagsRouter.routes());
    if (ctx.request.url.pathname === "/api/health") { ctx.response.body = {}; }
    if (ctx.request.url.pathname.startsWith("/api/")) { await next(); return; }
    await send(ctx, path, { root: WEB_DIR });
  `;
  const model = serverRoutes([
    { file: "api/main.ts", source: main },
    {
      file: "api/episodes.ts",
      source:
        'export const episodesRouter = new Router();\nepisodesRouter.get("/api/episodes", h);',
    },
    {
      file: "api/tags.ts",
      source:
        'export const tagsRouter = new Router();\ntagsRouter.get("/", h);\ntagsRouter.get("/:id", h);',
    },
  ]);

  assertEquals(model.routes.map((r) => `${r.method} ${r.pattern}`), [
    "GET /api/episodes",
    "GET /api/tags",
    "GET /api/tags/:id",
    "GET /api/health",
    "GET /:path*",
  ]);
  assertEquals(model.unmounted, []);
});

Deno.test("serverRoutes: a router nobody mounts is reported, not counted as served", () => {
  const main = `
    import { episodesRouter } from "./episodes.ts";
    import { ghostsRouter } from "./ghosts.ts";
    app.use(episodesRouter.routes());
  `;
  const model = serverRoutes([
    { file: "api/main.ts", source: main },
    {
      file: "api/episodes.ts",
      source:
        'export const episodesRouter = new Router();\nepisodesRouter.get("/api/episodes", h);',
    },
    {
      file: "api/ghosts.ts",
      source: 'export const ghostsRouter = new Router();\nghostsRouter.get("/api/ghosts", h);',
    },
  ]);

  assertEquals(model.routes.map((r) => r.pattern), ["/api/episodes"]);
  assertEquals(model.unmounted, ["GET /api/ghosts (ghostsRouter in api/ghosts.ts)"]);
});

Deno.test("importedModules: variable to module path, resolved from the entry point", () => {
  const main = `
    import { episodesRouter } from "./episodes.ts";
    import { joinPath } from "../shared/paths.ts";
  `;
  assertEquals([...importedModules("api/main.ts", main)], [
    ["episodesRouter", "api/episodes.ts"],
    ["joinPath", "shared/paths.ts"],
  ]);
});

Deno.test("routeMatches: literals, :params and the :path* wildcard", () => {
  assert(routeMatches("/api/episodes", "/api/episodes"));
  assert(routeMatches("/api/episodes/:id", "/api/episodes/63"));
  assert(routeMatches("/api/playlists/:id/episodes/:episodeId", "/api/playlists/2/episodes/9"));
  assert(routeMatches("/:path*", "/about.html"));

  assert(!routeMatches("/api/episodes/:id", "/api/episodes/63/summary"), "no trailing segments");
  assert(!routeMatches("/api/episodes/:id", "/api/episodes"), "a param needs a value");
  assert(!routeMatches("/api/Episodes", "/api/episodes"), "literals are case-sensitive");
  assert(!routeMatches("/:path*", "/"), "the wildcard needs one segment");
});

// ------------------------------------------- can the checker fail? (the point)

/** A minimal two-file server: one router, mounted with no prefix. */
const syntheticServer = (routerSource: string) => [
  {
    file: "api/main.ts",
    source: `import { episodesRouter } from "./episodes.ts";
app.use(episodesRouter.routes());`,
  },
  {
    file: "api/episodes.ts",
    source: `export const episodesRouter = new Router();\n${routerSource}`,
  },
];

Deno.test("checkContract: a client path with no route is reported, with the path and method", () => {
  const { calls } = clientCalls('return api(`/episodes/${id}/typo`, { method: "PUT" });', "x.js");
  const routes =
    serverRoutes(syntheticServer('episodesRouter.put("/api/episodes/:id", h);')).routes;

  const mismatches = checkContract({ calls, routes, prefix: "/api" });

  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0].fullPath, "/api/episodes/:param/typo");
  assertEquals(mismatches[0].reason, "no route serves PUT /api/episodes/:param/typo");
});

Deno.test("checkContract: the right path with the wrong method is a mismatch too", () => {
  const { calls } = clientCalls('return api("/episodes", { method: "POST" });', "x.js");
  const routes = serverRoutes(
    syntheticServer('episodesRouter.get("/api/episodes", h);'),
  ).routes;

  const mismatches = checkContract({ calls, routes, prefix: "/api" });

  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0].reason, "a route serves /api/episodes, but not for POST");
});

Deno.test("checkContract: a doubled /api prefix would be caught", () => {
  // The shape of the bug this test class exists for: a path that already carries
  // the prefix, composed onto the prefix again.
  const { calls } = clientCalls('return api("/api/episodes/63", { method: "PUT" });', "x.js");
  const routes =
    serverRoutes(syntheticServer('episodesRouter.put("/api/episodes/:id", h);')).routes;

  const mismatches = checkContract({ calls, routes, prefix: "/api" });

  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0].fullPath, "/api/api/episodes/63");
  assertEquals(mismatches[0].reason, "no route serves PUT /api/api/episodes/63");
});

Deno.test("checkContract: the static fallthrough does not swallow API paths", () => {
  const { calls } = clientCalls('return api("/episodez", {});', "x.js");
  const model = serverRoutes([
    {
      file: "api/main.ts",
      source: `import { episodesRouter } from "./episodes.ts";
app.use(episodesRouter.routes());
if (ctx.request.url.pathname.startsWith("/api/")) { await next(); return; }
await send(ctx, path, { root: WEB_DIR });`,
    },
    {
      file: "api/episodes.ts",
      source:
        'export const episodesRouter = new Router();\nepisodesRouter.get("/api/episodes", h);',
    },
  ]);

  const mismatches = checkContract({ calls, routes: model.routes, prefix: "/api" });

  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0].reason, "no route serves GET /api/episodez");
});

// ------------------------------------------------------- the real repository

const sources = await serverSources();
const appSources: Array<{ file: string; source: string }> = [];
for (const file of await clientFiles()) {
  appSources.push({ file, source: await read(file) });
}

Deno.test("contract: the app composes every relative path onto the apiUrl prefix", async () => {
  const appSource = await read("web/app.js");
  assertEquals(apiPrefix(appSource), "/api");
  assertStringIncludes(appSource, "const resp = await fetch(`${API_BASE}${path}`, options);");
});

Deno.test("contract: the extraction is not vacuous (a broken parser fails loudly)", () => {
  const calls = appSources.flatMap((s) => clientCalls(s.source, s.file).calls);
  const routes = serverRoutes(sources).routes.length;

  assert(calls.length >= 20, `expected 20+ literal call sites, found ${calls.length}`);
  assert(routes >= 20, `expected 20+ server routes, found ${routes}`);
});

Deno.test("contract: exactly one dynamic call site, and it is the helper itself", () => {
  const skipped = appSources.map((s) => clientCalls(s.source, s.file)).reduce(
    (sum, ex) => sum + ex.skipped,
    0,
  );
  assertEquals(skipped, 1, "the api() helper composes the URL; any other needs review");
});

Deno.test("contract: every router the entry point imports is mounted", () => {
  const { unmounted } = serverRoutes(sources);
  assertEquals(unmounted, [], "a route on an unmounted router is a 404 in production");
});

Deno.test("contract: every call site resolves to a route the server serves", () => {
  const appSource = appSources.find((s) => s.file === "web/app.js")!.source;
  const calls = appSources.flatMap((s) => clientCalls(s.source, s.file).calls);
  const routes = serverRoutes(sources).routes;
  const mismatches = checkContract({ calls, routes, prefix: apiPrefix(appSource)! });

  assertEquals(
    mismatches.map((m) => `${m.call.file} ${m.call.raw} -> ${m.reason}`),
    [],
  );
});

Deno.test("contract: the families the app actually depends on are all present", () => {
  const calls = appSources.flatMap((s) => clientCalls(s.source, s.file).calls);
  // Absolute call sites (fetch("/api/...")) already carry the prefix; relative
  // ones are compared the way the browser resolves them.
  const found = new Set(
    calls.map((c) => `${c.method} ${c.absolute ? c.path : `/api${c.path}`}`),
  );

  for (
    const expected of [
      "GET /api/auth/me",
      "DELETE /api/auth/me",
      "POST /api/auth/logout",
      "GET /api/auth/users",
      "POST /api/auth/users/:param/role",
      "GET /api/episodes",
      "GET /api/episodes/:param",
      "GET /api/characters",
      "GET /api/keywords",
      "GET /api/search",
      "GET /api/watched",
      "PUT /api/watched/:param",
      "DELETE /api/watched/:param",
      "GET /api/playlists",
      "POST /api/playlists",
      "GET /api/playlists/:param",
      "PUT /api/playlists/:param",
      "DELETE /api/playlists/:param",
      "POST /api/playlists/:param/episodes",
      "DELETE /api/playlists/:param/episodes/:param",
    ]
  ) {
    assert(found.has(expected), `expected the app to call ${expected}`);
  }
});

Deno.test("contract: the sign-in link is a route too, not just a call", () => {
  const calls = appSources.flatMap((s) => clientCalls(s.source, s.file).calls);
  const navigation = calls.filter((c) => c.kind === "navigation");
  const routes = serverRoutes(sources).routes;

  assert(navigation.length >= 1, "expected the Sign in with Google link");
  assertEquals(
    checkContract({ calls: navigation, routes, prefix: "/api" }),
    [],
    "a navigation to a route the server does not serve is a dead button",
  );
});
