import "dotenv/config";
import { createClient, type Client } from "@libsql/client";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { migrateSqliteFileToTurso } from "../src/turso-migration.js";

type CliOptions = {
  from?: string;
  url?: string;
  token?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--from" && next) {
      options.from = next;
      index += 1;
    } else if (arg.startsWith("--from=")) {
      options.from = arg.slice("--from=".length);
    } else if (arg === "--url" && next) {
      options.url = next;
      index += 1;
    } else if (arg.startsWith("--url=")) {
      options.url = arg.slice("--url=".length);
    } else if (arg === "--token" && next) {
      options.token = next;
      index += 1;
    } else if (arg.startsWith("--token=")) {
      options.token = arg.slice("--token=".length);
    }
  }
  return options;
}

function resolveRemoteConfig(options: CliOptions) {
  const url = options.url ?? process.env.NANOLLM_TURSO_DATABASE_URL ?? process.env.TURSO_DATABASE_URL;
  const authToken = options.token ?? process.env.NANOLLM_TURSO_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    throw new Error("Missing Turso database URL. Pass --url or set NANOLLM_TURSO_DATABASE_URL / TURSO_DATABASE_URL.");
  }
  return { url, authToken };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.from) {
    throw new Error("Missing source sqlite path. Pass --from /path/to/nanollm.sqlite3.");
  }

  const sourcePath = resolve(process.cwd(), options.from);
  if (!existsSync(sourcePath)) {
    throw new Error(`Source sqlite file not found: ${sourcePath}`);
  }

  const remote = resolveRemoteConfig(options);
  const target = createClient({ url: remote.url, authToken: remote.authToken, intMode: "number", readYourWrites: true });

  try {
    await migrateSqliteFileToTurso(target, sourcePath, { logger: console.log });
    console.log(`Migration complete: ${sourcePath} -> ${remote.url}`);
  } finally {
    target.close();
  }
}

await main();
