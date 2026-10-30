import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, watchFile, unwatchFile, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  materializeConfig,
  parseConfigDocument,
  parseConfigText,
  type ParsedConfigDocument,
  type ServerConfig,
} from "./config.js";
import { migrateLegacyAuthTokens } from "./token-migration.js";

export type ConfigUpdateSource = "startup" | "ui" | "file-watch";

export interface ConfigLoadError {
  message: string;
  source: ConfigUpdateSource;
  occurredAt: number;
}

export interface ConfigSnapshot {
  version: number;
  rawText: string;
  effectiveConfig: ServerConfig;
  requiresRestartFields: string[];
  lastError?: ConfigLoadError;
}

export interface ApplyConfigResult {
  snapshot: ConfigSnapshot;
  appliedFields: string[];
  requiresRestartFields: string[];
}

const RELOAD_DEBOUNCE_MS = 150;
const WATCH_INTERVAL_MS = 500;

export function writeFileAtomic(path: string, text: string) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, text, "utf-8");
  renameSync(tempPath, path);
}

/** Written to a config path that doesn't exist yet, so nanollm starts without a hand-made config. */
export function defaultConfigText(port: number): string {
  return `server:\n  port: ${port}\n`;
}

/**
 * Creates a missing config file (and its directory) holding only the port from `choosePort`.
 * Returns that port, or undefined when the file already exists.
 */
export async function ensureConfigFile(path: string, choosePort: () => Promise<number>): Promise<number | undefined> {
  if (existsSync(path)) return undefined;
  const port = await choosePort();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, defaultConfigText(port), { encoding: "utf-8", flag: "wx" });
  return port;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getRestartFields(intended: ServerConfig, effective: ServerConfig): string[] {
  const fields: string[] = [];
  if (!sameValue(intended.port, effective.port)) fields.push("server.port");
  if (!sameValue(intended.auth?.token, effective.auth?.token)) fields.push("server.auth.token");
  return fields;
}

function materializeHotConfig(document: ParsedConfigDocument, current: ServerConfig): ServerConfig {
  return materializeConfig(document, {
    port: current.port,
    authToken: current.auth?.token ?? "",
  });
}

export class ConfigManager {
  private snapshot: ConfigSnapshot;
  private lastObservedHash = "";
  private reloadTimer?: NodeJS.Timeout;
  private readonly listeners = new Set<(result: ApplyConfigResult, source: ConfigUpdateSource) => void>();

  constructor(private readonly configPath: string) {
    const rawText = this.readMigrated();
    const effectiveConfig = parseConfigText(rawText);
    this.snapshot = {
      version: 1,
      rawText,
      effectiveConfig,
      requiresRestartFields: [],
    };
    this.lastObservedHash = hashText(rawText);
    this.startWatching();
  }

  getActiveSnapshot(): ConfigSnapshot {
    return this.snapshot;
  }

  applyText(rawText: string, source: ConfigUpdateSource): ApplyConfigResult {
    const nextHash = hashText(rawText);
    if (source !== "startup" && nextHash === this.lastObservedHash) {
      return {
        snapshot: this.snapshot,
        appliedFields: [],
        requiresRestartFields: this.snapshot.requiresRestartFields,
      };
    }

    try {
      const document = parseConfigDocument(rawText);
      const intendedConfig = parseConfigText(rawText);
      const effectiveConfig =
        source === "startup"
          ? intendedConfig
          : materializeHotConfig(document, this.snapshot.effectiveConfig);
      const requiresRestartFields = getRestartFields(intendedConfig, effectiveConfig);

      this.snapshot = {
        version: this.snapshot.version + 1,
        rawText,
        effectiveConfig,
        requiresRestartFields,
      };
      this.lastObservedHash = nextHash;
      const result = {
        snapshot: this.snapshot,
        appliedFields: ["providers", "models", "fallback", "server.ttfb_timeout", "record.max_size", "record.skip_when"],
        requiresRestartFields,
      };
      for (const listener of this.listeners) {
        listener(result, source);
      }
      return result;
    } catch (error) {
      this.snapshot = {
        version: this.snapshot.version + 1,
        rawText,
        effectiveConfig: this.snapshot.effectiveConfig,
        requiresRestartFields: this.snapshot.requiresRestartFields,
        lastError: {
          message: error instanceof Error ? error.message : String(error),
          source,
          occurredAt: Date.now(),
        },
      };
      this.lastObservedHash = nextHash;
      throw error;
    }
  }

  dispose() {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    unwatchFile(this.configPath);
    this.listeners.clear();
  }

  onUpdate(listener: (result: ApplyConfigResult, source: ConfigUpdateSource) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reads the config file, first rewriting legacy model and group `auth_token` fields into `tokens`. */
  private readMigrated(): string {
    const rawText = readFileSync(this.configPath, "utf-8");
    const migrated = migrateLegacyAuthTokens(rawText);
    if (migrated === undefined) return rawText;
    writeFileAtomic(this.configPath, migrated);
    console.log(`[CONFIG MIGRATE] moved model and fallback group auth_token fields into tokens in ${this.configPath}`);
    return migrated;
  }

  private startWatching() {
    watchFile(
      this.configPath,
      { interval: WATCH_INTERVAL_MS },
      (current, previous) => {
        if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = undefined;
          this.reloadFromDisk();
        }, RELOAD_DEBOUNCE_MS);
      },
    );
  }

  private reloadFromDisk() {
    try {
      const rawText = this.readMigrated();
      const nextHash = hashText(rawText);
      if (nextHash === this.lastObservedHash) return;
      this.applyText(rawText, "file-watch");
      console.log(`[CONFIG RELOAD] reloaded from ${this.configPath}`);
    } catch (error) {
      console.error(`[CONFIG RELOAD FAILED] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
