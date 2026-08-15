/**
 * TNGPlaylists — PostgreSQL client
 *
 * Thin wrapper around the @db/postgres client. Reads connection config
 * from DATABASE_URL env var. Follows the Notes app pattern.
 */

import { Client } from "jsr:@db/postgres";

export interface DbConfig {
  url: string;
}

export function getDbConfig(): DbConfig {
  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    throw new Error(
      "DATABASE_URL not set — e.g. postgres://tng_user:PASS@localhost:5434/tngplaylists",
    );
  }
  return { url };
}

let _client: Client | null = null;

/** Get a shared Postgres client (created lazily, one per process). */
export async function getClient(): Promise<Client> {
  if (_client) return _client;
  const { url } = getDbConfig();
  _client = new Client(url);
  await _client.connect();
  return _client;
}

/**
 * Execute a query returning rows as arrays.
 * Mirrors the Notes app's `query()` convenience for simple cases.
 */
export async function queryArray(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[][] }> {
  const client = await getClient();
  return client.queryArray(sql, params);
}

/**
 * Execute a query returning rows as objects (lowercase keys).
 */
export async function queryObject(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[] }> {
  const client = await getClient();
  return client.queryObject(sql, params);
}

/** Close the shared client (for tests / shutdown). */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end();
    _client = null;
  }
}
