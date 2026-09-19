/**
 * The response-envelope contract, checked by reading the route handlers (see
 * envelope.ts for why), plus a live check over HTTP when a database is configured.
 *
 * Two halves, same as the route contract:
 *   - synthetic tests: can the checker FAIL? (every rule below is shown a case
 *     that breaks it, because a guard that has never failed is a guess)
 *   - the real repository: every route answers in the envelope the client parses,
 *     including the list and single-item routes by name.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { envelopeViolations, handlers } from "./envelope.ts";
import { read, serverSources } from "./repo.ts";
import { declaredRoutes, serverRoutes } from "./route_contract.ts";

// ------------------------------------------- can the checker fail? (the point)

const oneRoute = (body: string) =>
  handlers(
    `export const r = new Router();\nr.get("/api/thing", async (ctx) => {\n${body}\n});`,
    "synthetic.ts",
  )[0];

Deno.test("envelope: a bare array body is a violation (the client parses the envelope)", () => {
  const problems = envelopeViolations(oneRoute("  ctx.response.body = rows;"));

  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "neither an object literal nor undefined");
});

Deno.test("envelope: an object without success is a violation", () => {
  const problems = envelopeViolations(oneRoute("  ctx.response.body = { data: rows };"));

  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "has no `success` field");
});

Deno.test("envelope: success without data is a violation", () => {
  const problems = envelopeViolations(oneRoute("  ctx.response.body = { success: true };"));

  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "no `data` field");
});

Deno.test("envelope: failure without an error message is a violation", () => {
  // The client shows `data?.error`; a bare `success: false` renders as "HTTP 500".
  const problems = envelopeViolations(
    oneRoute("  ctx.response.status = 400;\n  ctx.response.body = { success: false };"),
  );

  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "no `error` message");
});

Deno.test("envelope: error bodies are enveloped too, and pass", () => {
  const problems = envelopeViolations(
    oneRoute(
      '  ctx.response.status = 404;\n  ctx.response.body = { success: false, error: "nope" };',
    ),
  );
  assertEquals(problems, []);
});

Deno.test("envelope: a bodiless 200 is a violation, a 204 without a body is not", () => {
  const bad = envelopeViolations(oneRoute("  ctx.response.body = undefined;"));
  assertEquals(bad.length, 1);
  assertStringIncludes(bad[0], "204");

  const good = envelopeViolations(
    oneRoute("  ctx.response.status = 204;\n  ctx.response.body = undefined;"),
  );
  assertEquals(good, []);
});

Deno.test("envelope: a status set in an earlier branch is not this reply's status", () => {
  // The false positive this check must not have: an early-return 404 above a
  // perfectly ordinary success body is not "a body on a 204".
  const problems = envelopeViolations(
    oneRoute(
      [
        "  if (bad) {",
        "    ctx.response.status = 404;",
        '    ctx.response.body = { success: false, error: "nope" };',
        "    return;",
        "  }",
        "  ctx.response.body = { success: true, data: { ok: true } };",
      ].join("\n"),
    ),
  );
  assertEquals(problems, []);
});

Deno.test("envelope: a 204 with a body is a violation (Oak refuses it at runtime)", () => {
  const problems = envelopeViolations(
    oneRoute("  ctx.response.status = 204;\n  ctx.response.body = { success: true, data: {} };"),
  );
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "body on a 204");
});

Deno.test("envelope: a handler that never answers is a violation", () => {
  const problems = envelopeViolations(oneRoute("  await next();"));
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "never answers");
});

// ------------------------------------------------------- the real repository

const sources = await serverSources();
const entrySource = sources[0].source;

/** Every route the server declares, as `METHOD pattern` per file. */
const declared = sources.flatMap((s) =>
  declaredRoutes(s.source, s.file).map((r) => `${r.method} ${r.pattern}`)
);
const analyzed = sources.flatMap((s) => handlers(s.source, s.file));

Deno.test("envelope: every declared route in every module was analyzed", () => {
  // The completeness link: the envelope rules are worthless on a route the
  // extractor walked past, so the two counts must be equal, and non-trivial.
  assertEquals(
    analyzed.map((h) => `${h.method} ${h.pattern}`).sort(),
    declared.slice().sort(),
  );
  assert(analyzed.length >= 20, `expected 20+ routes, found ${analyzed.length}`);
  assert(
    analyzed.reduce((sum, h) => sum + h.assignments.length, 0) >= 30,
    "expected 30+ body assignments, found fewer",
  );
});

Deno.test("envelope: no route violates the envelope (health route included)", () => {
  const problems = analyzed.flatMap(envelopeViolations);
  assertEquals(problems, []);
});

Deno.test("envelope: the entry point's own /api/health answers in the envelope", () => {
  assertStringIncludes(
    entrySource,
    'ctx.response.body = { success: true, data: { status: "ok", db: "connected" } };',
  );
});

Deno.test("envelope: the list routes answer with { success: true, data: ... }", () => {
  const expected = new Map([
    ["/api/episodes", "GET"],
    ["/api/characters", "GET"],
    ["/api/keywords", "GET"],
    ["/api/search", "GET"],
    ["/api/playlists", "GET"],
    ["/api/watched", "GET"],
    ["/api/auth/users", "GET"],
  ]);

  for (const [pattern, method] of expected) {
    const handler = analyzed.find((h) => h.method === method && h.pattern === pattern);
    assert(handler, `no handler was found for ${method} ${pattern}`);
    const ok = handler.assignments.filter((a) => a.success === "true" && a.hasData);
    assert(ok.length >= 1, `${method} ${pattern} has no success+data body`);
  }

  // And the routes really are served: the entry point mounts their routers.
  const { routes, unmounted } = serverRoutes(sources);
  assertEquals(unmounted, []);
  for (const [pattern] of expected) {
    assert(routes.some((r) => r.pattern === pattern), `${pattern} is not a served route`);
  }
});

Deno.test("envelope: the single-item routes answer with { success: true, data: ... }", () => {
  // The routes whose "no such thing" answer is a 404: they must be enveloped in
  // both directions.
  const withNotFound = [
    "GET /api/episodes/:id",
    "GET /api/episodes/:id/summary",
    "GET /api/playlists/:id",
    "GET /api/characters/:name",
  ];

  for (const label of withNotFound) {
    const [method, pattern] = label.split(" ");
    const handler = analyzed.find((h) => h.method === method && h.pattern === pattern);
    assert(handler, `no handler was found for ${label}`);
    const ok = handler.assignments.filter((a) => a.success === "true" && a.hasData);
    assert(ok.length >= 1, `${label} has no success+data body`);
    const notFound = handler.assignments.filter((a) =>
      a.success === "false" && a.hasError && a.status === 404
    );
    assert(notFound.length >= 1, `${label} has no enveloped 404 branch`);
  }

  // GET /api/auth/me is the one single-item route with no 404 branch: nobody
  // signed in is `{ success: true, data: { user: null } }`, not an error.
  const me = analyzed.find((h) => h.method === "GET" && h.pattern === "/api/auth/me");
  assert(me, "no handler was found for GET /api/auth/me");
  assertEquals(me.assignments.length, 1);
  assertEquals(
    [me.assignments[0].success, me.assignments[0].hasData],
    ["true", true],
    "GET /api/auth/me must answer the envelope with a nullable user",
  );
});

Deno.test("envelope: the three bodiless DELETE routes say 204", async () => {
  // These are the only non-JSON success replies in the API. If a fourth appears,
  // this test fails and someone has to decide whether the client can parse it.
  const bodiless: string[] = [];
  for (const handler of analyzed) {
    for (const assignment of handler.assignments) {
      if (assignment.kind === "undefined") {
        bodiless.push(`${handler.method} ${handler.pattern} (${handler.file})`);
        assertEquals(assignment.status, 204, `${handler.method} ${handler.pattern}`);
      }
    }
  }
  assertEquals(bodiless.sort(), [
    "DELETE /api/playlists/:id (api/playlists.ts)",
    "DELETE /api/playlists/:id/episodes/:episodeId (api/playlists.ts)",
    "DELETE /api/watched/:episodeId (api/watched.ts)",
  ]);
  assertStringIncludes(await read("web/app.js"), "if (resp.status === 204) return null;");
});
