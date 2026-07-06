import { createClient, type Client } from "@libsql/client";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATION_STATE_TABLE = "nanollm_migration_state";
const COPY_BATCH_SIZE = 25;

export interface TursoAutoMigrationConfig {
  sourcePath: string;
  migrationKey: string;
}

export function resolveTursoAutoMigrationConfig(env: NodeJS.ProcessEnv = process.env): TursoAutoMigrationConfig | undefined {
  const rawSourcePath = env.NANOLLM_TURSO_AUTO_MIGRATE_FROM;
  if (!rawSourcePath) return undefined;
  const sourcePath = resolve(process.cwd(), rawSourcePath);
  return {
    sourcePath,
    migrationKey: `auto-import:${sourcePath}`,
  };
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function makeCreateStatementIdempotent(sql: string): string {
  return sql
    .replace(/^CREATE\s+TABLE\s+/i, "CREATE TABLE IF NOT EXISTS ")
    .replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (_match, unique: string | undefined) => `CREATE ${unique ?? ""}INDEX IF NOT EXISTS `);
}

async function listSchemaObjects(client: Client, type: "table" | "index") {
  const result = await client.execute({
    sql: `
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = ? AND name NOT LIKE 'sqlite_%' AND name != ? AND sql IS NOT NULL
      ORDER BY name
    `,
    args: [type, MIGRATION_STATE_TABLE],
  });
  return result.rows.map((row) => ({
    name: String(row.name),
    sql: String(row.sql),
  }));
}

async function listColumns(client: Client, tableName: string) {
  const result = await client.execute(`PRAGMA table_info(${quoteIdent(tableName)})`);
  return result.rows.map((row) => String(row.name));
}

async function copyTable(source: Client, target: Client, tableName: string) {
  const columns = await listColumns(source, tableName);
  if (columns.length === 0) return 0;

  const columnSql = columns.map(quoteIdent).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const insertSql = `INSERT OR REPLACE INTO ${quoteIdent(tableName)} (${columnSql}) VALUES (${placeholders})`;
  let copied = 0;

  while (true) {
    const rows = (await source.execute({
      sql: `SELECT ${columnSql} FROM ${quoteIdent(tableName)} LIMIT ? OFFSET ?`,
      args: [COPY_BATCH_SIZE, copied],
    })).rows;
    if (rows.length === 0) break;

    const chunk = rows.map((row) => ({
      sql: insertSql,
      args: columns.map((column) => row[column] as string | number | bigint | ArrayBuffer | null),
    }));
    await target.batch(chunk, "write");
    copied += rows.length;
  }

  return copied;
}

async function ensureMigrationStateTable(target: Client) {
  await target.executeMultiple(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_STATE_TABLE} (
      migration_key TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    );
  `);
}

async function hasCompletedMigration(target: Client, migrationKey: string) {
  const result = await target.execute({
    sql: `SELECT 1 FROM ${MIGRATION_STATE_TABLE} WHERE migration_key = ?`,
    args: [migrationKey],
  });
  return result.rows.length > 0;
}

export async function migrateSqliteFileToTurso(target: Client, sourcePath: string, options?: { logger?: (message: string) => void }) {
  if (!existsSync(sourcePath)) {
    throw new Error(`Source sqlite file not found: ${sourcePath}`);
  }

  const logger = options?.logger ?? (() => {});
  const source = createClient({ url: pathToFileURL(sourcePath).href, intMode: "number", timeout: 5000 });
  try {
    const tables = await listSchemaObjects(source, "table");
    const indexes = await listSchemaObjects(source, "index");
    for (const table of tables) {
      await target.executeMultiple(makeCreateStatementIdempotent(table.sql));
    }

    for (const table of tables) {
      const rowCount = await copyTable(source, target, table.name);
      logger(`Copied ${table.name}: ${rowCount} rows`);
    }

    for (const index of indexes) {
      await target.executeMultiple(makeCreateStatementIdempotent(index.sql));
    }
  } finally {
    source.close();
  }
}

export async function autoMigrateSqliteFileToTurso(
  target: Client,
  config: TursoAutoMigrationConfig,
  options?: { logger?: (message: string) => void },
) {
  const logger = options?.logger ?? (() => {});
  await ensureMigrationStateTable(target);
  if (await hasCompletedMigration(target, config.migrationKey)) {
    logger(`Skipping Turso auto migration; already completed for ${config.sourcePath}`);
    return false;
  }

  logger(`Starting Turso auto migration from ${config.sourcePath}`);
  await migrateSqliteFileToTurso(target, config.sourcePath, { logger });
  await target.execute({
    sql: `
      INSERT INTO ${MIGRATION_STATE_TABLE} (migration_key, source_path, completed_at)
      VALUES (?, ?, ?)
    `,
    args: [config.migrationKey, config.sourcePath, Date.now()],
  });
  logger(`Completed Turso auto migration from ${config.sourcePath}`);
  return true;
}
