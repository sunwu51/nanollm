import { createHash } from "node:crypto";
import { readFileSync, watchFile, unwatchFile } from "node:fs";
import {
  materializeConfig,
  parseConfigDocument,
  parseConfigText,
  type ParsedConfigDocument,
  type ServerConfig,
} from "./config.js";

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

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getRestartFields(intended: ServerConfig, effective: ServerConfig): string[] {
  const fields: string[] = [];
  if (!sameValue(intended.port, effective.port)) fields.push("server.port");
  return fields;
}

function materializeHotConfig(document: ParsedConfigDocument, current: ServerConfig): ServerConfig {
  return materializeConfig(document, {
    port: current.port,
  });
}

export class ConfigManager {
  private snapshot: ConfigSnapshot;
  private lastObservedHash = "";
  private reloadTimer?: NodeJS.Timeout;
  private readonly listeners = new Set<(result: ApplyConfigResult, source: ConfigUpdateSource) => void>();

  constructor(private readonly configPath: string) {
    const rawText = readFileSync(this.configPath, "utf-8");
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
        appliedFields: ["models", "fallback", "server.ttfb_timeout", "record.max_size"],
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
      const rawText = readFileSync(this.configPath, "utf-8");
      const nextHash = hashText(rawText);
      if (nextHash === this.lastObservedHash) return;
      this.applyText(rawText, "file-watch");
      console.log(`[CONFIG RELOAD] reloaded from ${this.configPath}`);
    } catch (error) {
      console.error(`[CONFIG RELOAD FAILED] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
