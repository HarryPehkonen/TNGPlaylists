/**
 * The client/server URL contract: every path the browser asks for must be a
 * route the server actually serves.
 *
 * Why this file exists (the class of bug, not just the spirit): a dead route is
 * invisible to every other kind of test in this suite. Nothing renders a DOM,
 * nothing starts a server, nothing opens a connection — so a call site pointing
 * at a URL that does not exist fails only in front of a user, as a toast that
 * says something unhelpful. That is a whole category of bug that no unit test
 * can see, and it is cheap to close by reading the sources.
 *
 * So the contract is DERIVED FROM THE SOURCES, never listed by hand:
 *   - client paths: the literal arguments of the `api(...)` helper and of plain
 *     `fetch("/api/...")` calls in web/, plus `el.href = "/api/..."` navigations
 *     (a link is a GET the server must serve too)
 *   - server routes: `NAME.get|post|put|delete("...")` in every module the entry
 *     point imports, where NAME is a `new Router()` declared in that module
 *   - the mount prefix for each router variable, read out of api/main.ts
 *   - the composition rule: a relative client path is prefixed with API_BASE
 *     (web/app.js owns that constant); a path that already starts with "/api/"
 *     is used as-is (this repo has both conventions — see web/account-actions.js)
 * Nothing here needs a browser, a database, or a running server: it is text
 * analysis, so it runs in the gate on every commit and every night.
 *
 * Three rules keep it from passing vacuously (all three learned the hard way):
 *   1. the extractors must FIND a plausible number of calls and routes — a
 *      parser that silently matches nothing would otherwise "prove" anything;
 *   2. call sites whose path cannot be read statically are COUNTED, and the test
 *      asserts the exact count, so a new dynamic site has to be reviewed by hand;
 *   3. the checker must be shown to fail on a planted mismatch (the synthetic
 *      tests in route_contract_test.ts do exactly that).
 */

// ---------------------------------------------------------------------------
// A tiny code scanner
//
// Regex alone is not enough here: `api(` inside a string or a comment is not a
// call site, an argument list holds nested parens, quotes and `${}` templates,
// and the options object is usually spread over several lines. So callee matches
// are taken only at real code positions, and each argument list is read by
// bracket-matching with strings/comments skipped.
// ---------------------------------------------------------------------------

export type Literal = { value: string; quote: string };

/** The character after a string/template/comment starting at `source[i]`, or i. */
function skipLiteralOrComment(source: string, i: number): number {
  const c = source[i];
  if (c === "/" && source[i + 1] === "/") {
    const end = source.indexOf("\n", i);
    return end === -1 ? source.length : end;
  }
  if (c === "/" && source[i + 1] === "*") {
    const end = source.indexOf("*/", i + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (c === '"' || c === "'" || c === "`") {
    return readLiteral(source, i)?.end ?? i + 1;
  }
  return i;
}

/**
 * Read a string/template literal starting at the quote at `source[i]`.
 * `${...}` inside a template is skipped as a unit (with its braces balanced), so
 * a template containing code cannot end the literal early.
 */
export function readLiteral(
  source: string,
  i: number,
): { value: string; quote: string; end: number } | null {
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  let j = i + 1;
  while (j < source.length) {
    const c = source[j];
    if (c === "\\") {
      value += source.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (c === quote) return { value, quote, end: j + 1 };
    if (quote === "`" && c === "$" && source[j + 1] === "{") {
      value += source.slice(j, j + 2);
      let depth = 1;
      j += 2;
      while (j < source.length && depth > 0) {
        const d = source[j];
        if (d === "{") depth++;
        else if (d === "}") depth--;
        else {
          const skipped = skipLiteralOrComment(source, j);
          if (skipped !== j) {
            value += source.slice(j, skipped);
            j = skipped;
            continue;
          }
        }
        value += d;
        j++;
      }
      continue;
    }
    if (quote !== "`" && c === "\n") return null; // unterminated single-line string
    value += c;
    j++;
  }
  return null;
}

/** The text between a balanced pair of brackets (`(`/`)`, `{`/`}`). */
export function readBalanced(
  source: string,
  open: number,
  openChar = "(",
  closeChar = ")",
): { text: string; end: number } | null {
  let depth = 0;
  let j = open;
  while (j < source.length) {
    const skipped = skipLiteralOrComment(source, j);
    if (skipped !== j) {
      j = skipped;
      continue;
    }
    const c = source[j];
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return { text: source.slice(open + 1, j), end: j + 1 };
    }
    j++;
  }
  return null;
}

/** The text between the parens that open at `open` (index of "("), exclusive. */
function readArguments(source: string, open: number): { text: string; end: number } | null {
  return readBalanced(source, open, "(", ")");
}

export type CallSite = {
  /** Offset in the source, for stable ordering. */
  index: number;
  /** The argument list text. */
  args: string;
  /** First argument, when it is a plain literal (no `${}` in a template). */
  firstArg: Literal | null;
};

/**
 * Every site where `name(` is called, at a real code position. `excludeAfter`
 * drops sites preceded by that text (the `function api(` definition).
 * @param {string} source
 * @param {string} name
 * @param {string} [excludeAfter]
 * @returns {CallSite[]}
 */
export function callSites(source: string, name: string, excludeAfter = ""): CallSite[] {
  const sites: CallSite[] = [];
  const needle = `${name}(`;
  let i = 0;
  while (i < source.length) {
    const skipped = skipLiteralOrComment(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (source.startsWith(needle, i)) {
      const prev = i > 0 ? source[i - 1] : "";
      const isMember = prev === "." || /[\w$]/.test(prev);
      const isDefinition = excludeAfter !== "" &&
        source.slice(Math.max(0, i - 20), i).endsWith(excludeAfter);
      if (!isDefinition && !isMember) {
        const args = readArguments(source, i + name.length);
        if (args) {
          const trimmed = args.text.trimStart();
          const leading = args.text.length - trimmed.length;
          const literal =
            trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`")
              ? readLiteral(trimmed, 0)
              : null;
          // A template whose first character is `${` is not a readable path.
          const usable = literal && !(literal.quote === "`" && literal.value.startsWith("${"))
            ? { value: literal.value, quote: literal.quote }
            : null;
          sites.push({ index: i, args: args.text.slice(leading), firstArg: usable });
        }
      }
      i += needle.length;
      continue;
    }
    i++;
  }
  return sites;
}

/** String literals inside an options fragment, e.g. `method: "PUT" : "DELETE"`. */
function methodsFromOptions(options: string): string[] {
  const out: string[] = [];
  const re = /method\s*:\s*([^,}]*)/g;
  for (const match of options.matchAll(re)) {
    for (const literal of match[1].matchAll(/"([A-Z]+)"|'([A-Z]+)'/g)) {
      out.push(literal[1] ?? literal[2]);
    }
  }
  return out.length ? out : ["GET"];
}

/**
 * The API prefix the client composes every relative path onto. web/app.js owns it.
 * @param {string} appSource
 * @returns {string|null}
 */
export function apiPrefix(appSource: string): string | null {
  const match = appSource.match(/API_BASE\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * The path a client URL resolves to, as far as it can be read statically:
 *   - each `${...}` that sits where a SEGMENT belongs (`/episodes/${id}`) becomes
 *     one opaque `:param` segment, because that is what it is at the wire level;
 *   - a `${...}` that starts anywhere else ends the readable path: it may be
 *     carrying the whole query string (`/keywords${cat ? "?category=" + cat : ""}`),
 *     and guessing what is inside it would be inventing a URL.
 * Then the query string is dropped and repeated slashes collapsed.
 * @param {string} raw - the literal text of a template/string, quotes removed
 * @returns {string}
 */
export function normalizePath(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "$" && raw[i + 1] === "{") {
      if (!out.endsWith("/")) break; // not a segment: everything from here is unknown
      out += ":param";
      let depth = 0;
      let j = i + 1;
      while (j < raw.length) {
        if (raw[j] === "{") depth++;
        else if (raw[j] === "}" && --depth === 0) break;
        j++;
      }
      i = j;
      continue;
    }
    out += raw[i];
  }

  const path = out.split("?")[0].replace(/\/{2,}/g, "/");
  if (path === "") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export type ClientCall = {
  file: string;
  method: string;
  /** Path as written at the call site (`:param` for each `${...}`). */
  path: string;
  /** True when the path already carries its prefix (fetch("/api/...")). */
  absolute: boolean;
  kind: "call" | "navigation";
  /** The call site source, for readable failure messages. */
  raw: string;
};

export type Extraction = {
  calls: ClientCall[];
  /** Sites whose path is built dynamically, so no literal can be read. */
  skipped: number;
  /** Literal sites that are not paths at all (e.g. an external URL). */
  other: number;
  /** The `function api(` definition sites that were excluded by name. */
  definitions: number;
};

/**
 * Every literal client call in one client file. Handles all three shapes this
 * repo has: the `api("/path", { method })` helper, a plain `fetch("/api/...")`,
 * and `el.href = "/api/..."` navigation.
 * @param {string} source
 * @param {string} file
 * @returns {Extraction}
 */
export function clientCalls(source: string, file: string): Extraction {
  const calls: ClientCall[] = [];
  let skipped = 0;
  let other = 0;

  // The helper's own definition is not a call site; count it so a rename is noticed.
  const definitions = (source.match(/(?<![\w$.])function\s+api\(/g) ?? []).length;

  const push = (site: CallSite, absolute: boolean, kind: "call" | "navigation") => {
    if (!site.firstArg) {
      skipped++;
      return;
    }
    const path = site.firstArg.value;
    // A path is a path only if it starts at the root: anything else (an https://
    // URL) is a literal, but not one of ours.
    if (!path.startsWith("/")) {
      other++;
      return;
    }
    // Relative (the api() helper composes onto API_BASE) or absolute (a fetch that
    // carries /api itself). Deliberately decided by the CALL SHAPE, not by what the
    // string looks like: `api("/api/notes")` must still fail as /api/api/notes.
    for (const method of methodsFromOptions(site.args)) {
      calls.push({
        file,
        method,
        path: normalizePath(path),
        absolute,
        kind,
        raw: `${kind}("${path}")`.slice(0, 80),
      });
    }
  };

  for (const site of callSites(source, "api", "function ")) push(site, false, "call");
  for (const site of callSites(source, "fetch")) push(site, true, "call");

  // `el.href = "/api/auth/login"` — a browser navigation the server must serve.
  for (const match of source.matchAll(/\.href\s*=\s*(["'`])(\/api\/[^"'`]*)\1/g)) {
    calls.push({
      file,
      method: "GET",
      path: normalizePath(match[2]),
      absolute: true,
      kind: "navigation",
      raw: `.href = ${JSON.stringify(match[2])}`.slice(0, 80),
    });
  }

  return { calls, skipped, other, definitions };
}

// ---------------------------------------------------------------------------
// The server side
// ---------------------------------------------------------------------------

export type ServerRoute = {
  file: string;
  method: string;
  /** Full pattern including the mount prefix, Oak's `:param` / `:path*` syntax. */
  pattern: string;
  /** The router variable this route was declared on. */
  router: string;
  /** A prefix this route deliberately does NOT serve (e.g. the static fallthrough). */
  notUnder?: string;
};

/** Router variables declared in a module (`const x = new Router()`). */
export function routerVariables(source: string): string[] {
  return [...source.matchAll(/const\s+(\w+)\s*=\s*new\s+Router\(/g)].map((m) => m[1]);
}

export type RouteSite = {
  /** Offset of the route declaration, for stable ordering. */
  index: number;
  router: string;
  method: string;
  pattern: string;
  /** Everything between the route's parens: middleware names and the handler. */
  args: string;
};

/**
 * Every route declared in a module (before any mount prefix), with the source of
 * its whole argument list — which is what the response-envelope check reads.
 */
export function routeSites(source: string): RouteSite[] {
  const vars = new Set(routerVariables(source));
  const sites: RouteSite[] = [];
  for (
    const match of source.matchAll(/(\w+)\.(get|post|put|delete)\(\s*(["'`])([^"'`]*)\3/g)
  ) {
    if (!vars.has(match[1])) continue;
    // The route's own argument list opens at the "(" that precedes the path
    // literal (the path is the first argument).
    const open = match.index + match[0].indexOf("(");
    const args = readArguments(source, open);
    if (!args) continue;
    sites.push({
      index: match.index,
      router: match[1],
      method: match[2].toUpperCase(),
      pattern: match[4],
      args: args.text,
    });
  }
  return sites;
}

/** Every route declared in a module, before any mount prefix is applied. */
export function declaredRoutes(source: string, file: string): ServerRoute[] {
  return routeSites(source).map((site) => ({
    file,
    method: site.method,
    pattern: site.pattern,
    router: site.router,
  }));
}

/** `import { a, b } from "./x.ts"` → variable → resolved module path. */
export function importedModules(
  entryFile: string,
  source: string,
): Map<string, string> {
  const dir = entryFile.replace(/\/[^/]*$/, "");
  const out = new Map<string, string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)) {
    for (const name of match[1].split(",")) {
      const clean = name.trim();
      if (clean) out.set(clean, joinPath(dir, match[2]));
    }
  }
  return out;
}

export function joinPath(dir: string, spec: string): string {
  const parts = `${dir}/${spec}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

/**
 * Which prefix each router variable is mounted at, read out of the entry point.
 * A mount with no path literal (`app.use(episodesRouter.routes())`) means "":
 * that router's own patterns already carry `/api/...`.
 * @param {string} mainSource
 * @returns {Map<string, string>} router variable -> mount prefix
 */
export function mountedRouters(mainSource: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of mainSource.matchAll(/app\.use\(\s*(?:"([^"]*)",\s*)?(\w+)\.routes\(\)/g)) {
    out.set(match[2], match[1] ?? "");
  }
  return out;
}

export type ServerModel = {
  routes: ServerRoute[];
  /** Router variables mounted nowhere: their routes are dead in production. */
  unmounted: string[];
};

/**
 * All routes the server serves, with mount prefixes applied. Routes declared on
 * a router that the entry point never mounts are reported as unmounted instead
 * of being counted as served — a route nobody can reach is not a route.
 *
 * The entry point's own routes come from the sources too: every
 * `pathname === "/api/..."` comparison is a route, and a `send(ctx, ...)` static
 * fallthrough (guarded by a `/api/` bail-out) is the wildcard that serves
 * everything else. Neither is hard-coded, so moving a route changes the model.
 * @param {Array<{file: string, source: string}>} sources - entry point first
 */
export function serverRoutes(sources: Array<{ file: string; source: string }>): ServerModel {
  const entry = sources[0];
  const mounts = mountedRouters(entry.source);
  const routes: ServerRoute[] = [];
  const unmounted: string[] = [];

  for (const { file, source } of sources) {
    if (file === entry.file) continue;
    for (const route of declaredRoutes(source, file)) {
      if (!mounts.has(route.router)) {
        unmounted.push(`${route.method} ${route.pattern} (${route.router} in ${file})`);
        continue;
      }
      const prefix = mounts.get(route.router)!;
      // A mounted router's own "/" route IS the mount, not the mount with a
      // trailing slash (Oak would answer /api/tags but the model would say
      // /api/tags/ and every call site would look like a mismatch).
      const pattern = route.pattern === "/" ? prefix : `${prefix}${route.pattern}`;
      routes.push({
        ...route,
        pattern: (pattern === "" ? "/" : pattern).replace(/\/{2,}/g, "/"),
      });
    }
  }

  // The entry point's own JSON route: `if (pathname === "/api/health")`.
  for (const match of entry.source.matchAll(/pathname\s*===\s*"(\/api\/[^"]*)"/g)) {
    routes.push({ file: entry.file, method: "GET", pattern: match[1], router: "(entry)" });
  }

  // The static fallthrough: serves any path that is not an API path.
  const apiBailOut = /startsWith\("\/api\/"\)/.test(entry.source);
  if (apiBailOut && /send\(\s*ctx\s*,/.test(entry.source)) {
    routes.push({
      file: entry.file,
      method: "GET",
      pattern: "/:path*",
      router: "(static)",
      notUnder: "/api/",
    });
  }

  return { routes, unmounted };
}

/**
 * Does a route pattern serve a concrete path? `:name` matches exactly one
 * segment, a trailing `:path*` matches one or more, literals must match, and
 * there are no trailing segments or extras.
 * @param {string} pattern
 * @param {string} path
 * @returns {boolean}
 */
export function routeMatches(pattern: string, path: string): boolean {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);

  for (let i = 0; i < patternSegments.length; i++) {
    const segment = patternSegments[i];
    if (segment.endsWith("*")) {
      return i === patternSegments.length - 1 && pathSegments.length > i;
    }
    if (i >= pathSegments.length) return false;
    if (segment.startsWith(":")) continue;
    if (segment !== pathSegments[i]) return false;
  }

  return patternSegments.length === pathSegments.length;
}

export type Mismatch = { call: ClientCall; fullPath: string; reason: string };

/** Does this route serve this concrete path? (notUnder excludes a prefix.) */
function serves(route: ServerRoute, fullPath: string): boolean {
  if (route.notUnder && fullPath.startsWith(route.notUnder)) return false;
  return routeMatches(route.pattern, fullPath);
}

/**
 * The whole check: every client call must resolve to a route, with the method it
 * uses. Returns the mismatches (empty means the contract holds).
 */
export function checkContract(
  { calls, routes, prefix }: { calls: ClientCall[]; routes: ServerRoute[]; prefix: string },
): Mismatch[] {
  const mismatches: Mismatch[] = [];

  for (const call of calls) {
    const fullPath = call.absolute
      ? normalizePath(call.path)
      : normalizePath(`${prefix}${call.path}`);
    const forMethod = routes.filter((route) => route.method === call.method);
    if (forMethod.some((route) => serves(route, fullPath))) continue;

    const anyMethod = routes.some((route) => serves(route, fullPath));
    mismatches.push({
      call,
      fullPath,
      reason: anyMethod
        ? `a route serves ${fullPath}, but not for ${call.method}`
        : `no route serves ${call.method} ${fullPath}`,
    });
  }

  return mismatches;
}
