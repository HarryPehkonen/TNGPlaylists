/**
 * The response envelope, over HTTP, from the real server.
 *
 * envelope_test.ts reads the sources, which proves what the handlers SAY they
 * reply. This file proves what the server actually replies: it starts api/main.ts
 * as a child process, waits for /api/health, and checks the envelope on the one
 * route shape a source-derived check cannot reach — a real reply, with a real
 * content type and status, from the middleware stack the browser talks to.
 *
 * It needs a database, so it does not run by default: `deno task test` only
 * includes it when DATABASE_URL is set, and prints that it skipped otherwise —
 * a skipped check is not a passed check, and pretending otherwise is the bug this
 * whole directory exists to prevent. Run it with:
 *
 *     DATABASE_URL=postgres://... deno task test
 *
 * An empty database is enough: the routes this checks are the health route, the
 * list routes (empty is a valid list), the 404 branch of the single-item routes,
 * the 401 branch of the authenticated ones — and the static entry point.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { ROOT_PATH } from "./repo.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const PORT = Number(Deno.env.get("TNG_TEST_PORT") ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 20_000;

if (!DATABASE_URL) {
  console.log(
    [
      "api_live_test: SKIPPED — DATABASE_URL is not set, so the running server was not",
      "  checked over HTTP (the source-derived envelope test above still ran).",
      "  To include it: export DATABASE_URL=postgres://... and run `deno task test`.",
    ].join("\n"),
  );
}

type Reply = { status: number; contentType: string; body: string; json: Record<string, unknown> };

async function get(path: string): Promise<Reply> {
  const response = await fetch(`${BASE}${path}`);
  const body = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(body);
  } catch {
    json = {};
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body,
    json,
  };
}

/** Poll /api/health until the child answers or the budget runs out. */
async function waitForHealth(): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const reply = await get("/api/health");
      if (reply.status === 200) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

Deno.test({
  name: "live: the running server answers in the envelope on every route shape",
  ignore: !DATABASE_URL,
  fn: async () => {
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net",
        "--allow-read",
        "--allow-env",
        "--allow-write",
        "api/main.ts",
      ],
      cwd: ROOT_PATH,
      env: { DATABASE_URL: DATABASE_URL!, PORT: String(PORT) },
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    try {
      if (!await waitForHealth()) {
        child.kill();
        const output = await child.output();
        throw new Error(
          `the server did not answer ${BASE}/api/health within ${BOOT_TIMEOUT_MS / 1000}s\n${
            new TextDecoder().decode(output.stderr)
          }`,
        );
      }

      // The health route: the envelope, from the handler, with a real db check.
      const health = await get("/api/health");
      assertEquals(health.status, 200);
      assertEquals(health.json.success, true);
      assertEquals((health.json.data as Record<string, unknown>).db, "connected");
      assertStringIncludes(health.contentType, "application/json");

      // The list routes: an empty database is still an enveloped list.
      const episodes = await get("/api/episodes");
      assertEquals(episodes.status, 200);
      assertEquals(episodes.json.success, true);
      const episodeData = episodes.json.data as Record<string, unknown>;
      assert(Array.isArray(episodeData.episodes), "data.episodes must be an array");
      assert(typeof (episodeData.meta as Record<string, unknown>).total === "number");

      const playlists = await get("/api/playlists");
      assertEquals(playlists.status, 200);
      assertEquals(playlists.json.success, true);
      assert(
        Array.isArray((playlists.json.data as Record<string, unknown>).playlists),
        "data.playlists must be an array",
      );

      // The single-item routes: the 404 branch, enveloped with an error string.
      for (
        const path of ["/api/episodes/999999", "/api/playlists/999999", "/api/characters/NOPE"]
      ) {
        const missing = await get(path);
        assertEquals(missing.status, 404, path);
        assertEquals(missing.json.success, false, path);
        assert(typeof missing.json.error === "string", path);
        assertStringIncludes(missing.contentType, "application/json");
      }

      // The authenticated routes: the 401 branch, enveloped too.
      for (const path of ["/api/watched", "/api/auth/users"]) {
        const denied = await get(path);
        assertEquals(denied.status, 401, path);
        assertEquals(denied.json.success, false, path);
      }

      // /api/auth/me answers 200 with a null user when nobody is signed in.
      const me = await get("/api/auth/me");
      assertEquals(me.status, 200);
      assertEquals(me.json.success, true);

      // The static entry point, and a versioned asset reference: the identity
      // pair's browser-facing half resolves to real bytes (Oak ignores the query).
      const page = await get("/");
      assertEquals(page.status, 200);
      assertStringIncludes(page.contentType, "text/html");

      const asset = await get("/app.js?v=1.0.0");
      assertEquals(asset.status, 200, "a versioned asset URL must still be served");
      assertStringIncludes(asset.contentType, "javascript");
      assertStringIncludes(asset.body, "function api(path, options");

      const styles = await get("/styles.css?v=1.0.0");
      assertEquals(styles.status, 200);
      assertStringIncludes(styles.contentType, "text/css");
    } finally {
      child.kill();
      await child.status;
    }
  },
});
