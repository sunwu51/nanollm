import { createClient, type Client, type ResultSet } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export type SqliteClient = Client;
const clientWriteChains = new WeakMap<SqliteClient, Promise<void>>();

export interface TursoConfig {
  url: string;
  authToken?: string;
}

export interface SqliteStorageConnection {
  client: SqliteClient;
  driver: "local" | "turso";
  location: string;
}

export function resolveTursoConfig(env: NodeJS.ProcessEnv = process.env): TursoConfig | undefined {
  const url = env.NANOLLM_TURSO_DATABASE_URL ?? env.TURSO_DATABASE_URL;
  const authToken = env.NANOLLM_TURSO_AUTH_TOKEN ?? env.TURSO_AUTH_TOKEN;
  if (!url && !authToken) return undefined;
  if (!url) {
    throw new Error("Turso auth token is set but database URL is missing. Set NANOLLM_TURSO_DATABASE_URL or TURSO_DATABASE_URL.");
  }
  return { url, authToken };
}

export async function openSqliteStorage(dbPath: string, turso = resolveTursoConfig()): Promise<SqliteStorageConnection> {
  if (turso) {
    const client = createClient({
      url: turso.url,
      authToken: turso.authToken,
      intMode: "number",
      readYourWrites: true,
    });
    return {
      client,
      driver: "turso",
      location: turso.url,
    };
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const client = createClient({
    url: pathToFileURL(dbPath).href,
    intMode: "number",
    timeout: 5000,
  });
  await client.executeMultiple(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);
  return {
    client,
    driver: "local",
    location: dbPath,
  };
}

export function firstRow<T extends Record<string, unknown>>(result: ResultSet): T | undefined {
  return result.rows[0] as unknown as T | undefined;
}

export function allRows<T extends Record<string, unknown>>(result: ResultSet): T[] {
  return result.rows as unknown as T[];
}

export function enqueueClientWrite(client: SqliteClient, task: () => Promise<void>) {
  const current = clientWriteChains.get(client) ?? Promise.resolve();
  const next = current.then(task, task);
  clientWriteChains.set(client, next.catch(() => {}));
  return next;
}

export async function waitForClientWrites(client: SqliteClient) {
  await (clientWriteChains.get(client) ?? Promise.resolve());
}
