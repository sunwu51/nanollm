import { createHash } from "node:crypto";
import { CLAUDE_CODE_VERSION } from "./subscription-client-compat.js";

const BILLING_PREFIX = "x-anthropic-billing-header:";
const FINGERPRINT_SALT = "59cf53e54c78";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstUserText(messages: unknown[]): string {
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const firstText = message.content.find((block) => isRecord(block) && block.type === "text");
      return isRecord(firstText) && typeof firstText.text === "string" ? firstText.text : "";
    }
    return "";
  }
  return "";
}

function billingVersion(userAgent: string | undefined): string {
  return /^claude-cli\/(\d+\.\d+\.\d+)(?:\b|$)/i.exec(userAgent ?? "")?.[1] ?? CLAUDE_CODE_VERSION;
}

function billingText(messages: unknown[], version: string): string {
  const bytes = Buffer.from(firstUserText(messages), "utf8");
  const chars = Buffer.from([4, 7, 20].map((index) => bytes[index] ?? 0x30));
  const fingerprint = createHash("sha256").update(FINGERPRINT_SALT).update(chars).update(version).digest("hex").slice(0, 3);
  return `${BILLING_PREFIX} cc_version=${version}.${fingerprint}; cc_entrypoint=cli;`;
}

/** Add Claude Code billing attribution as a system text block, without a cch field. */
export function addClaudeBillingBlock(body: unknown, userAgent: string | undefined): unknown {
  if (!isRecord(body) || !Array.isArray(body.messages)) return body;
  const system = body.system;
  if (typeof system === "string" && system.startsWith(BILLING_PREFIX)) return body;
  if (Array.isArray(system) && system.some((block) => isRecord(block) && typeof block.text === "string" && block.text.startsWith(BILLING_PREFIX))) return body;
  if (system !== undefined && system !== null && typeof system !== "string" && !Array.isArray(system)) return body;

  const block = { type: "text", text: billingText(body.messages, billingVersion(userAgent)) };
  const original = Array.isArray(system) ? system : typeof system === "string" && system ? [{ type: "text", text: system }] : [];
  return { ...body, system: [block, ...original] };
}
