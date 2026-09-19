/**
 * The response-envelope contract: every JSON route answers with an envelope the
 * client can parse, and a route that answers with no body says so with a 204.
 *
 * Why this file exists: web/app.js parses every reply with one helper —
 *
 *     const data = await resp.json().catch(() => null);
 *     if (!resp.ok || (data && data.success === false)) throw new Error(data?.error || `HTTP ${resp.status}`);
 *     return data?.data ?? data;
 *
 * so the client is written against the envelope, in two shapes: a success reply
 * `{ success: true, data: ... }` and a failure reply `{ success: false, error }`.
 * A route that answers with a bare array (or a bare row) still "works" in the
 * happy path, because of the `?? data` fallback, and then fails in a way nobody
 * can explain the first time a request is not ok. Nothing else catches that: no
 * unit test sees a response, and the integration test needs a database.
 *
 * The rules (each one is something the client or Oak actually requires):
 *   1. an object body must carry `success`
 *   2. `success: true` must carry `data` (the client returns `data?.data ?? data`)
 *   3. `success: false` must carry `error` (the client throws `data?.error`, and
 *      "HTTP 500" is not an error message a user can act on)
 *   4. a bodiless body (`= undefined`) must follow a 204 — a 200 with no body
 *      gives the client `resp.json()` -> null -> `undefined`, silently
 *   5. a body directly after a 204 is refused by Oak at runtime
 *   6. a handler that never assigns a body never answers
 *
 * Rules 4 and 5 read the status assignment IMMEDIATELY above the body assignment
 * (only whitespace and comments between), not "some status set earlier in the
 * handler" — a 404 in an early-return branch is not the status of the reply at
 * the bottom of the handler, and guessing that it is would make this check lie.
 *
 * Like the route contract, this reads text rather than running a server, so it
 * runs with no database, no port and no fixture — and, like it, the checker is
 * shown to fail on planted violations in envelope_test.ts. The one thing text
 * cannot prove is that the running server behaves this way, so api_live_test.ts
 * checks the same envelope over HTTP when a database is configured (and says
 * loudly that it skipped when one is not).
 */
import { readBalanced, routeSites } from "./route_contract.ts";

export type BodyAssignment = {
  /** `object` (an object literal), `undefined`, or something unreadable. */
  kind: "object" | "undefined" | "other";
  /** For an object literal: the literal value of `success`, when it is a literal. */
  success: "true" | "false" | null;
  /** For an object literal: does it carry `data`? */
  hasData: boolean;
  /** For an object literal: does it carry `error`? */
  hasError: boolean;
  /** The status set immediately above it, if any. */
  status: number | null;
  /** One line of the assignment, for failure messages. */
  raw: string;
};

export type Handler = {
  file: string;
  method: string;
  pattern: string;
  router: string;
  assignments: BodyAssignment[];
};

const FIELD_RE = (name: string) => new RegExp(`(^|[,{\\s])${name}\\s*:`);
const SUCCESS_RE = /(^|[,{\s])success\s*:\s*(true|false)\s*([,}]|$)/;

/** Whitespace and comments only between these two offsets? */
function onlyTrivia(source: string, from: number, to: number): boolean {
  if (from > to) return false;
  let i = from;
  while (i < to) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? to : end + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? to : end + 2;
      continue;
    }
    return false;
  }
  return true;
}

/** Read the value expression starting at `start`, as far as it can be read. */
function readValue(source: string, start: number): { kind: BodyAssignment["kind"]; text: string } {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source.startsWith("undefined", i)) return { kind: "undefined", text: "undefined" };
  if (source[i] === "{") {
    const braced = readBalanced(source, i, "{", "}");
    return { kind: "object", text: braced?.text ?? "" };
  }
  // A body that is not an object literal (a variable, an await, a string): it
  // cannot be judged from the text, and it must not pass by default.
  return { kind: "other", text: source.slice(i, i + 40) };
}

/** Every route in a module, with each `ctx.response.body = ...` it assigns. */
export function handlers(source: string, file: string): Handler[] {
  return routeSites(source).map((site) => {
    const args = site.args;

    const statusAssignments: Array<{ start: number; end: number; status: number }> = [];
    for (const match of args.matchAll(/ctx\.response\.status\s*=\s*(\d{3})\s*;/g)) {
      statusAssignments.push({
        start: match.index,
        end: match.index + match[0].length,
        status: Number(match[1]),
      });
    }

    const assignments: BodyAssignment[] = [];
    for (const match of args.matchAll(/ctx\.response\.body\s*=\s*/g)) {
      const { kind, text } = readValue(args, match.index + match[0].length);
      const immediate = statusAssignments
        .filter((s) => s.end <= match.index && onlyTrivia(args, s.end, match.index))
        .at(-1);
      assignments.push({
        kind,
        success: kind === "object"
          ? (text.match(SUCCESS_RE)?.[2] as "true" | "false" ?? null)
          : null,
        hasData: kind === "object" && FIELD_RE("data").test(text),
        hasError: kind === "object" && FIELD_RE("error").test(text),
        status: immediate ? immediate.status : null,
        raw: text.replace(/\s+/g, " ").slice(0, 70),
      });
    }

    return {
      file,
      method: site.method,
      pattern: site.pattern,
      router: site.router,
      assignments,
    };
  });
}

/** Everything wrong with one handler, as sentences a human can act on. */
export function envelopeViolations(handler: Handler): string[] {
  const where = `${handler.method} ${handler.pattern} (${handler.file})`;
  const problems: string[] = [];

  if (handler.assignments.length === 0) {
    problems.push(`${where}: never assigns ctx.response.body — this route never answers`);
    return problems;
  }

  for (const assignment of handler.assignments) {
    const at = `body = "${assignment.raw}"`;
    switch (assignment.kind) {
      case "other":
        problems.push(
          `${where}: ${at} is neither an object literal nor undefined, so the envelope cannot be verified`,
        );
        break;
      case "undefined":
        if (assignment.status !== 204) {
          problems.push(
            `${where}: ${at} has no body but no 204 above it (status ${
              assignment.status ?? "defaults to 200"
            }) — the client would read null`,
          );
        }
        break;
      case "object": {
        if (assignment.status === 204) {
          problems.push(`${where}: ${at} is a body on a 204 — Oak refuses that at runtime`);
          break;
        }
        if (assignment.success === null) {
          problems.push(
            `${where}: ${at} has no \`success\` field — the client parses the envelope`,
          );
          break;
        }
        if (assignment.success === "true" && !assignment.hasData) {
          problems.push(`${where}: ${at} says success: true but carries no \`data\` field`);
          break;
        }
        if (assignment.success === "false" && !assignment.hasError) {
          problems.push(`${where}: ${at} says success: false but carries no \`error\` message`);
        }
        break;
      }
    }
  }

  return problems;
}
