import { createClient, type Client, type InStatement, type ResultSet } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type SqliteClient = Client;
type PendingStatementBatch = { statements: InStatement[]; ready: Promise<unknown>[] };
const clientWriteChains = new WeakMap<SqliteClient, Promise<void>>();
const clientPendingBatches = new WeakMap<SqliteClient, PendingStatementBatch>();

export interface RemoteSqliteConfig {
  url: string;
  authToken?: string;
}

export interface SqliteStorageConnection {
  client: SqliteClient;
  driver: "local" | "remote";
  location: string;
}

export function resolveSqliteConfig(env: NodeJS.ProcessEnv = process.env): RemoteSqliteConfig | undefined {
  const url = env.NANOLLM_SQLITE_URL;
  const authToken = env.NANOLLM_SQLITE_AUTH_TOKEN;
  if (!url && !authToken) return undefined;
  if (!url) {
    throw new Error("SQLite auth token is set but database URL is missing. Set NANOLLM_SQLITE_URL.");
  }
  return { url, authToken };
}

// Retry only the read-only wake-up probe. A failed write response does not tell
// us whether the server committed it, so replaying the real request is unsafe.
// A server that answered within idleMs is awake, so the probe is skipped until the
// connection goes quiet or a request fails; every probe is a full HTTP round trip.
export function createSqliteWakeFetch(url: string, authToken?: string, options: {
  maxAttempts?: number; delayMs?: number; maxDelayMs?: number; probeTimeoutMs?: number; idleMs?: number;
} = {}): typeof fetch {
  const { maxAttempts = 20, delayMs = 1000, maxDelayMs = 5000, probeTimeoutMs = 5000, idleMs = 60_000 } = options;
  let awakeUntil = 0;
  const waitUntilAwake = async () => {
    for (let attempt = 0; ; attempt++) {
      const probe = createClient({ url, authToken, fetch: (probeInput: Parameters<typeof fetch>[0], probeInit?: Parameters<typeof fetch>[1]) => {
        const signal = AbortSignal.timeout(probeTimeoutMs);
        return fetch(probeInput, { ...probeInit, signal: probeInit?.signal ? AbortSignal.any([probeInit.signal, signal]) : signal });
      } });
      try {
        await probe.execute("SELECT 1");
        return;
      } catch (error) {
        if (attempt + 1 >= maxAttempts) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(delayMs * 2 ** attempt, maxDelayMs)));
      } finally {
        probe.close();
      }
    }
  };
  return async (input, init) => {
    if (Date.now() >= awakeUntil) await waitUntilAwake();
    try {
      const response = await fetch(input, init);
      awakeUntil = response.ok ? Date.now() + idleMs : 0;
      return response;
    } catch (error) {
      awakeUntil = 0;
      throw error;
    }
  };
}

export async function openSqliteStorage(dbPath: string, remote = resolveSqliteConfig()): Promise<SqliteStorageConnection> {
  const location = remote?.url ?? dbPath;
  if (/^(?:https?|libsql|wss?):\/\//i.test(location)) {
    const client = createClient({
      url: location,
      authToken: remote?.authToken,
      fetch: /^(?:https?|libsql):\/\//i.test(location) ? createSqliteWakeFetch(location, remote?.authToken) : undefined,
      intMode: "number",
      readYourWrites: true,
    });
    return {
      client,
      driver: "remote",
      location,
    };
  }

  const localPath = location.startsWith("file:") ? fileURLToPath(location) : location;
  mkdirSync(dirname(localPath), { recursive: true });
  const client = createClient({
    url: pathToFileURL(localPath).href,
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
    location: localPath,
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
  clientWriteChains.set(client, next.catch(() => {
    console.error("[SQLite] Queued write failed; the operation was not replayed to avoid duplicate counters.");
  }));
  return next;
}

export async function waitForClientWrites(client: SqliteClient) {
  await (clientWriteChains.get(client) ?? Promise.resolve());
}

// Statements enqueued before the pending batch starts are sent together in one write batch,
// so the status and usage counters of a request share a single round trip to a remote database.
// The batch waits for every caller's ready promise (schema setup) before it runs.
export function enqueueClientStatements(client: SqliteClient, statements: InStatement[], ready?: Promise<unknown>) {
  let pending = clientPendingBatches.get(client);
  if (!pending) {
    const batch: PendingStatementBatch = { statements: [], ready: [] };
    clientPendingBatches.set(client, batch);
    void enqueueClientWrite(client, async () => {
      clientPendingBatches.delete(client);
      await Promise.all(batch.ready);
      await client.batch(batch.statements, "write");
    });
    pending = batch;
  }
  pending.statements.push(...statements);
  if (ready) pending.ready.push(ready);
}
