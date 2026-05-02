import type { Message, MessageCreateParamsBase, MessageParam, ToolChoice, ToolUnion } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsBase,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions/completions";
import type { Response, ResponseCreateParamsBase, ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";

export type OpenAIChatRequest = ChatCompletionCreateParamsBase;
export type OpenAIResponsesRequest = ResponseCreateParamsBase;
export type AnthropicMessagesRequest = MessageCreateParamsBase;

export type OpenAIChatResponse = ChatCompletion;
export type OpenAIResponsesResponse = Response;
export type AnthropicMessagesResponse = Message;

export type NormalizedRole = "system" | "developer" | "user" | "assistant" | "tool" | "function";

export type NormalizedPart =
  | { type: "text"; text: string; cacheControl?: { type: "ephemeral" } }
  | { type: "refusal"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "image_url"; url: string; detail?: "auto" | "low" | "high"; cacheControl?: { type: "ephemeral" } }
  | { type: "input_audio"; data: string; format: "mp3" | "wav" }
  | { type: "document_url"; url: string; title?: string | null; cacheControl?: { type: "ephemeral" } }
  | { type: "document_base64"; data: string; mediaType?: string; title?: string | null; cacheControl?: { type: "ephemeral" } };

export type NormalizedTool =
  | {
      kind: "function";
      name: string;
      description?: string | null;
      inputSchema: Record<string, unknown>;
      strict?: boolean | null;
    }
  | {
      kind: "custom";
      name: string;
      description?: string | null;
      format?: unknown;
    };

export type NormalizedToolChoice =
  | { type: "auto"; disableParallel?: boolean }
  | { type: "required"; disableParallel?: boolean }
  | { type: "none" }
  | { type: "tool"; name: string; kind: "function" | "custom"; disableParallel?: boolean };

export type NormalizedToolCall =
  | { kind: "function"; id: string; name: string; payload: string }
  | { kind: "custom"; id: string; name: string; payload: string };

export interface NormalizedMessage {
  role: NormalizedRole;
  parts: NormalizedPart[];
  toolCalls?: NormalizedToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface NormalizedRequest {
  model: string;
  sourceFormat?: "openai-chat" | "openai-responses" | "anthropic";
  image?: boolean;
  maxOutputTokens?: number;
  messages: NormalizedMessage[];
  tools?: NormalizedTool[];
  toolChoice?: NormalizedToolChoice;
  metadata?: Record<string, unknown> | null;
  serviceTier?: string | null;
  stream?: boolean;
  temperature?: number | null;
  topP?: number | null;
  stopSequences?: string[];
  parallelToolCalls?: boolean;
  promptCacheKey?: string;
  promptCacheRetention?: "in-memory" | "24h" | null;
  safetyIdentifier?: string;
  reasoningEffort?: string | null;
  thinkingBudgetTokens?: number | null;
  textVerbosity?: "low" | "medium" | "high" | null;
  responseFormat?:
    | { type: "text" }
    | { type: "json_object" }
    | { type: "json_schema"; name: string; schema?: Record<string, unknown>; description?: string; strict?: boolean | null };
  cacheControl?: { type: string } | null;
}

export interface NormalizedUsage {
  inputTokens?: number;
  nonCacheInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface NormalizedResponse {
  id: string;
  createdAt: number;
  model: string;
  sourceFormat?: "openai-chat" | "openai-responses" | "anthropic";
  finishReason: string | null;
  message: NormalizedMessage;
  usage?: NormalizedUsage;
}

export function fail(message: string): never {
  throw new Error(message);
}

export function text(textValue: string): NormalizedPart {
  return { type: "text", text: textValue };
}

export function refusal(textValue: string): NormalizedPart {
  return { type: "refusal", text: textValue };
}

export function collapseText(parts: NormalizedPart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text" || part.type === "refusal") {
        return part.text;
      }

      fail(`Cannot collapse "${part.type}" to text`);
    })
    .join("\n");
}

export function requireTextOnly(parts: NormalizedPart[], context: string): NormalizedPart[] {
  for (const part of parts) {
    if (part.type !== "text" && part.type !== "refusal") {
      fail(`${context} only supports text content`);
    }
  }
  return parts;
}

export function parseJson(textValue: string, context: string): unknown {
  try {
    return JSON.parse(textValue);
  } catch {
    fail(`${context} contains invalid JSON`);
  }
}

export function stringifyJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function stringifyCustomToolValue(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === undefined || input === null) return "";
  return typeof input === "object" ? JSON.stringify(input) : String(input);
}

export function createResponsesCustomToolSchema(format?: unknown): Record<string, unknown> {
  let contentDescription: string | undefined;
  if (format && typeof format === "object") {
    const f = format as Record<string, unknown>;
    if (typeof f.definition === "string") {
      const label = typeof f.syntax === "string" ? `${f.syntax} grammar` : `${f.type ?? "format"} grammar`;
      contentDescription = `${label}:\n${f.definition}`;
    }
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      content: {
        type: "string",
        ...(contentDescription ? { description: contentDescription } : {}),
      },
    },
    required: ["content"],
  };
}

export function wrapResponsesCustomToolInput(input: unknown): string {
  return JSON.stringify({ content: stringifyCustomToolValue(input) });
}

export function unwrapResponsesCustomToolInput(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      if (typeof (parsed as Record<string, unknown>).content === "string") {
        return (parsed as Record<string, string>).content;
      }
      if (typeof (parsed as Record<string, unknown>).arg === "string") {
        return (parsed as Record<string, string>).arg;
      }
      return stringifyCustomToolValue(parsed);
    }
    return stringifyCustomToolValue(parsed);
  } catch {
    return stringifyCustomToolValue(argumentsText);
  }
}

const OPENAI_RESPONSES_MCP_QUALIFIED_TOOL_PATTERN = /^(mcp__.+?__)(.+)$/;

export function isOpenAIResponsesMcpNamespace(namespace: string | null | undefined): namespace is string {
  return typeof namespace === "string" && namespace.startsWith("mcp__");
}

export function joinOpenAIResponsesNamespacePath(name: string, namespace?: string | null): string {
  return namespace ? `${namespace}${name}` : name;
}

export function qualifyOpenAIResponsesToolName(name: string, namespace?: string | null): string {
  return isOpenAIResponsesMcpNamespace(namespace) ? joinOpenAIResponsesNamespacePath(name, namespace) : name;
}

export function splitQualifiedOpenAIResponsesToolName(name: string): { name: string; namespace?: string } {
  const match = OPENAI_RESPONSES_MCP_QUALIFIED_TOOL_PATTERN.exec(name);
  if (!match) return { name };

  const [, namespace, localName] = match;
  if (!isOpenAIResponsesMcpNamespace(namespace) || !localName) return { name };

  return {
    namespace,
    name: localName,
  };
}

export function makeDataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = url.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    mediaType: match[1],
    data: match[2],
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeReasoningEffortFromBudget(thinkingBudgetTokens: number | null | undefined): string | null {
  if (thinkingBudgetTokens == null) return null;
  if (thinkingBudgetTokens <= 3000) return "low";
  if (thinkingBudgetTokens <= 7500) return "medium";
  return "high";
}

export function normalizeUsage(usage: Record<string, unknown> | null | undefined): NormalizedUsage | undefined {
  if (!usage) return undefined;

  const providerInputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.prompt_tokens);
  const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.completion_tokens);
  const reasoningTokens =
    asNumber((usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens) ??
    asNumber((usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
  const cacheCreationInputTokens = asNumber(usage.cache_creation_input_tokens);
  const cacheReadInputTokens =
    asNumber(usage.cache_read_input_tokens) ??
    asNumber(usage.prompt_cache_hit_tokens) ??
    asNumber((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) ??
    asNumber((usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  const hasAnthropicCacheUsage = cacheCreationInputTokens != null || asNumber(usage.cache_read_input_tokens) != null;
  const nonCacheInputTokens = hasAnthropicCacheUsage
    ? providerInputTokens
    : providerInputTokens != null
      ? Math.max(0, providerInputTokens - (cacheReadInputTokens ?? 0))
      : undefined;
  const inputTokens = hasAnthropicCacheUsage
    ? (nonCacheInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) + (cacheReadInputTokens ?? 0)
    : providerInputTokens;
  const totalTokens =
    asNumber(usage.total_tokens) ??
    (inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);

  if (
    inputTokens == null &&
    nonCacheInputTokens == null &&
    outputTokens == null &&
    totalTokens == null &&
    reasoningTokens == null &&
    cacheCreationInputTokens == null &&
    cacheReadInputTokens == null
  ) {
    return undefined;
  }

  return {
    inputTokens,
    nonCacheInputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  };
}

export function denormalizeUsageToOpenAIChat(usage: NormalizedUsage | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;

  const promptTokens = usage.inputTokens;
  const completionTokens = usage.outputTokens;
  const totalTokens = usage.totalTokens ?? (promptTokens != null || completionTokens != null ? (promptTokens ?? 0) + (completionTokens ?? 0) : undefined);

  if (promptTokens == null && completionTokens == null && totalTokens == null) return undefined;

  return {
    ...(promptTokens != null ? { prompt_tokens: promptTokens } : {}),
    ...(completionTokens != null ? { completion_tokens: completionTokens } : {}),
    ...(totalTokens != null ? { total_tokens: totalTokens } : {}),
    ...(usage.reasoningTokens != null ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
    ...(usage.cacheReadInputTokens != null ? { prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens }, prompt_cache_hit_tokens: usage.cacheReadInputTokens } : {}),
  };
}

export function denormalizeUsageToOpenAIResponses(usage: NormalizedUsage | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;

  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const totalTokens = usage.totalTokens ?? (inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);

  if (inputTokens == null && outputTokens == null && totalTokens == null) return undefined;

  return {
    ...(inputTokens != null ? { input_tokens: inputTokens } : {}),
    ...(outputTokens != null ? { output_tokens: outputTokens } : {}),
    ...(totalTokens != null ? { total_tokens: totalTokens } : {}),
    ...(usage.reasoningTokens != null ? { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
    ...(usage.cacheReadInputTokens != null ? { input_tokens_details: { cached_tokens: usage.cacheReadInputTokens } } : {}),
  };
}

export function denormalizeUsageToAnthropic(usage: NormalizedUsage | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;

  const inputTokens = usage.nonCacheInputTokens ?? usage.inputTokens;
  const outputTokens = usage.outputTokens;

  if (inputTokens == null && outputTokens == null && usage.cacheCreationInputTokens == null && usage.cacheReadInputTokens == null) return undefined;

  return {
    ...(inputTokens != null ? { input_tokens: inputTokens } : {}),
    ...(outputTokens != null ? { output_tokens: outputTokens } : {}),
    ...(usage.cacheCreationInputTokens != null ? { cache_creation_input_tokens: usage.cacheCreationInputTokens } : {}),
    ...(usage.cacheReadInputTokens != null ? { cache_read_input_tokens: usage.cacheReadInputTokens } : {}),
    server_tool_use: null,
  };
}

export type {
  Message,
  MessageCreateParamsBase,
  MessageParam,
  ToolChoice,
  ToolUnion,
  ChatCompletion,
  ChatCompletionCreateParamsBase,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  Response,
  ResponseCreateParamsBase,
  ResponseInputItem,
  ResponseOutputItem,
};
