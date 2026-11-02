import type {
  AnthropicMessagesRequest,
  MessageCreateParamsBase,
  MessageParam,
  NormalizedCitation,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  NormalizedToolChoice,
  NormalizedWebSearch,
  OpenAIChatRequest,
  OpenAIResponsesRequest,
  ToolChoice,
  ToolUnion,
} from "./shared.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import {
  collapseText,
  createResponsesCustomToolSchema,
  decodeReasoningCarrier,
  fail,
  isReasoningCarrier,
  joinOpenAIResponsesNamespacePath,
  makeDataUrl,
  normalizeReasoningEffort,
  normalizeReasoningEffortFromBudget,
  parseDataUrl,
  parseToolArguments,
  qualifyOpenAIResponsesToolName,
  refusal,
  rejectFileContent,
  requireTextOnly,
  sanitizeAnthropicToolId,
  splitQualifiedOpenAIResponsesToolName,
  text,
  unwrapResponsesCustomToolInput,
  wrapResponsesCustomToolInput,
} from "./shared.js";
import {
  attachAnthropicWebSearchResult,
  startAnthropicWebSearch,
  type AnthropicSearchIndex,
  anthropicWebSearchBlocks,
  collectCitationTitles,
  collectCitedSnippets,
  denormalizeAnthropicWebSearchTool,
  denormalizeResponsesWebSearchTool,
  isAnthropicWebSearchTool,
  isResponsesWebSearchTool,
  isWebSearchCarrier,
  normalizeAnthropicCitations,
  normalizeAnthropicWebSearch,
  normalizeAnthropicWebSearchTool,
  normalizeResponsesAnnotations,
  normalizeResponsesWebSearch,
  normalizeResponsesWebSearchTool,
  normalizeWebSearchCarrier,
  responsesWebSearchItem,
  webSearchFunctionCallItems,
  webSearchNoteText,
  WEB_SEARCH_TOOL_NAME,
} from "./web-search.js";
import { getClientIp, getClientRequestHeaders, isResponsesCustomToolName, markResponsesCustomToolName } from "../core/request-context.js";
import { resolveSessionId } from "../core/session-id.js";

export interface AnthropicRequestConversionOptions {
  defaultMaxOutputTokens?: number;
  ignoreInvalidHistory?: boolean;
}

export function normalizeOpenAIChatRequest(request: OpenAIChatRequest): NormalizedRequest {
  const tools = request.tools?.flatMap((tool) => {
    const normalized = normalizeOpenAIChatTool(tool as any);
    return normalized ? [normalized] : [];
  });
  const toolChoice =
    request.tool_choice !== undefined
      ? normalizeOpenAIChatToolChoice(request.tool_choice as any)
      : request.function_call !== undefined
        ? normalizeOpenAIChatLegacyFunctionChoice(request.function_call as any)
        : undefined;

  return {
    model: request.model,
    sourceFormat: "openai-chat",
    maxOutputTokens: request.max_completion_tokens ?? request.max_tokens ?? undefined,
    messages: request.messages.flatMap((message) => normalizeOpenAIChatMessage(message as any)),
    tools: [
      ...(tools ?? []),
      ...(request.functions?.map((tool) => ({
        kind: "function" as const,
        name: tool.name,
        description: tool.description,
        inputSchema: (tool.parameters as Record<string, unknown> | undefined) ?? { type: "object" },
      })) ?? []),
    ],
    toolChoice: filterUnsupportedToolChoice(toolChoice, [...(tools ?? []), ...(request.functions?.map((tool) => ({ kind: "function" as const, name: tool.name })) ?? [])]),
    metadata: request.metadata ?? null,
    serviceTier: request.service_tier ?? null,
    stream: request.stream ?? false,
    temperature: request.temperature ?? null,
    topP: request.top_p ?? null,
    stopSequences: request.stop === undefined || request.stop === null ? undefined : Array.isArray(request.stop) ? request.stop : [request.stop],
    parallelToolCalls: request.parallel_tool_calls,
    promptCacheKey: request.prompt_cache_key ?? (request as any).promptCacheKey,
    promptCacheRetention: normalizePromptCacheRetention(request.prompt_cache_retention ?? (request as any).promptCacheRetention),
    safetyIdentifier: request.safety_identifier,
    reasoningEffort: normalizeReasoningEffort(request.reasoning_effort ?? request.reasoning?.effort),
    thinkingBudgetTokens: null,
    textVerbosity: request.verbosity ?? null,
    responseFormat: normalizeOpenAIChatResponseFormat(request.response_format as any),
    cacheControl: { type: "ephemeral" },
  };
}

export function normalizeOpenAIResponsesRequest(request: OpenAIResponsesRequest): NormalizedRequest {
  const messages: NormalizedMessage[] = [];
  if (request.instructions) {
    if (typeof request.instructions === "string") messages.push({ role: "developer", parts: [text(request.instructions)] });
    else messages.push(...normalizeOpenAIResponsesInput(request.instructions as any[]));
  }
  if (request.input !== undefined) messages.push(...normalizeOpenAIResponsesInput(typeof request.input === "string" ? request.input : (request.input as any[])));
  const additionalTools = Array.isArray(request.input)
    ? request.input.flatMap((item: any) => item?.type === "additional_tools" && Array.isArray(item.tools) ? item.tools : [])
    : [];
  const tools = [...(request.tools ?? []), ...additionalTools].flatMap((tool) => normalizeOpenAIResponsesTool(tool as any));
  const normalizedToolChoice = request.tool_choice ? normalizeOpenAIResponsesToolChoice(request.tool_choice as any) : undefined;

  return {
    model: request.model ?? "",
    sourceFormat: "openai-responses",
    maxOutputTokens: request.max_output_tokens ?? undefined,
    messages,
    tools,
    toolChoice: filterUnsupportedToolChoice(normalizedToolChoice, tools),
    metadata: request.metadata ?? null,
    serviceTier: request.service_tier ?? null,
    stream: request.stream ?? false,
    temperature: request.temperature ?? null,
    topP: request.top_p ?? null,
    parallelToolCalls: request.parallel_tool_calls,
    promptCacheKey: request.prompt_cache_key ?? (request as any).promptCacheKey,
    promptCacheRetention: normalizePromptCacheRetention(request.prompt_cache_retention ?? (request as any).promptCacheRetention),
    safetyIdentifier: request.safety_identifier,
    reasoningEffort: normalizeReasoningEffort(request.reasoning?.effort),
    thinkingBudgetTokens: null,
    textVerbosity: request.text?.verbosity ?? null,
    responseFormat: normalizeOpenAIResponsesFormat(request.text?.format as any),
    cacheControl: { type: "ephemeral" },
  };
}

export function normalizeAnthropicRequest(request: AnthropicMessagesRequest): NormalizedRequest {
  const messages: NormalizedMessage[] = [];
  if (request.system) messages.push(normalizeAnthropicSystem(request.system as any));
  const searches: AnthropicSearchIndex = new Map();
  for (const message of request.messages) messages.push(...normalizeAnthropicMessage(message, searches));

  // Anthropic has no prompt_cache_key; derive a per-conversation key the same way Claude subscriptions derive session ids.
  const promptCacheKey = resolveSessionId(request, { namespace: "prompt_cache_key", clientHeaders: getClientRequestHeaders(), clientIp: getClientIp() });
  const tools = request.tools?.flatMap((tool) => {
    const normalized = normalizeAnthropicTool(tool);
    return normalized ? [normalized] : [];
  });
  const normalizedToolChoice = request.tool_choice ? normalizeAnthropicToolChoice(request.tool_choice, tools) : undefined;

  return {
    model: request.model,
    sourceFormat: "anthropic",
    maxOutputTokens: request.max_tokens,
    messages,
    tools,
    toolChoice: filterUnsupportedToolChoice(normalizedToolChoice, tools),
    metadata: request.metadata ? { user_id: request.metadata.user_id ?? null } : null,
    serviceTier: request.service_tier ?? null,
    stream: request.stream ?? false,
    temperature: request.temperature ?? null,
    topP: request.top_p ?? null,
    stopSequences: request.stop_sequences,
    parallelToolCalls: normalizedToolChoice?.type === "none" ? undefined : normalizedToolChoice?.disableParallel === undefined ? undefined : !normalizedToolChoice.disableParallel,
    promptCacheKey,
    reasoningEffort:
      request.thinking?.type === "disabled"
        ? "none"
        : request.thinking?.type === "adaptive"
          ? request.output_config?.effort ?? null
          : normalizeReasoningEffortFromBudget(request.thinking?.type === "enabled" ? request.thinking.budget_tokens : null),
    thinkingBudgetTokens: request.thinking?.type === "enabled" ? request.thinking.budget_tokens : null,
    textVerbosity: null,
    responseFormat: request.output_config?.format ? { type: "json_schema", name: "anthropic_output", schema: request.output_config.format.schema } : undefined,
    cacheControl: { type: "ephemeral" },
  };
}

export function denormalizeToOpenAIChatRequest(request: NormalizedRequest): OpenAIChatRequest {
  const reasoningEffort = request.reasoningEffort ?? normalizeReasoningEffortFromBudget(request.thinkingBudgetTokens);
  return {
    model: request.model,
    messages: denormalizeOpenAIChatMessages(reorderMessagesForOpenAIChatToolResults(request.messages), request.image ?? true, collectCitationTitles(request.messages.flatMap((message) => message.parts))),
    max_completion_tokens: request.maxOutputTokens,
    metadata: request.metadata ?? undefined,
    service_tier: normalizeOpenAIServiceTier(request.serviceTier),
    stream: request.stream,
    stream_options: request.stream ? { include_usage: true } : undefined,
    temperature: request.temperature ?? undefined,
    top_p: request.topP ?? undefined,
    stop: request.stopSequences,
    parallel_tool_calls: request.parallelToolCalls,
    prompt_cache_key: request.promptCacheKey,
    prompt_cache_retention: (normalizePromptCacheRetention(request.promptCacheRetention) ?? undefined) as OpenAIChatRequest["prompt_cache_retention"],
    safety_identifier: request.safetyIdentifier,
    reasoning_effort: (reasoningEffort ?? undefined) as OpenAIChatRequest["reasoning_effort"],
    reasoning: reasoningEffort ? { effort: reasoningEffort as never } : undefined,
    verbosity: request.textVerbosity ?? undefined,
    response_format: denormalizeOpenAIChatResponseFormat(request.responseFormat),
    // Chat has no native web search tool (search is a model choice there).
    tools: request.tools?.flatMap<any>((tool) =>
      tool.kind === "function"
        ? [{ type: "function", function: { name: tool.name, description: tool.description ?? undefined, parameters: tool.inputSchema, strict: tool.strict ?? undefined } }]
        : tool.kind === "custom"
          ? [{ type: "custom", custom: { name: tool.name, description: tool.description ?? undefined, format: tool.format as never } }]
          : [],
    ) as OpenAIChatRequest["tools"],
    tool_choice: denormalizeOpenAIChatToolChoice(request.toolChoice),
  };
}

function denormalizeOpenAIChatMessages(messages: NormalizedMessage[], imageEnabled: boolean, citationTitles: Map<string, string>): OpenAIChatRequest["messages"] {
  const denormalized = messages.flatMap((message) => denormalizeOpenAIChatMessage(message, imageEnabled, citationTitles)) as any[];
  if (!imageEnabled) {
    const merged: any[] = [];
    for (const message of denormalized) {
      const previous = merged.at(-1);
      if (previous?.role === "assistant" && message?.role === "assistant") {
        if (previous.content === null && message.content !== null) {
          previous.content = message.content;
        } else if (previous.content !== null && message.content !== null) {
          previous.content = [previous.content, message.content].filter(Boolean).join("\n");
        }
        if (message.tool_calls?.length) {
          previous.tool_calls = [...(previous.tool_calls ?? []), ...message.tool_calls];
        }
        const prevThinking = previous.thinking || previous.reasoning || previous.reasoning_content || "";
        const msgThinking = message.thinking || message.reasoning || message.reasoning_content || "";
        const mergedThinking = [prevThinking, msgThinking].filter(Boolean).join("\n");
        if (mergedThinking) {
          previous.thinking = mergedThinking;
          previous.reasoning = mergedThinking;
          previous.reasoning_content = mergedThinking;
        }
        if (message.refusal && !previous.refusal) {
          previous.refusal = message.refusal;
        }
        continue;
      }
      if (previous?.role === "user" && message?.role === "user" && typeof previous.content === "string" && typeof message.content === "string") {
        previous.content = [previous.content, message.content].filter(Boolean).join("\n");
        continue;
      }
      merged.push(message);
    }
    return merged;
  }

  const merged: any[] = [];
  const pendingToolResultMedia: any[] = [];
  const flushToolResultMedia = () => {
    if (pendingToolResultMedia.length === 0) return;
    merged.push({ role: "user", content: pendingToolResultMedia.splice(0) });
  };
  for (const message of denormalized) {
    if (message?.__toolResultMedia) {
      pendingToolResultMedia.push(...(Array.isArray(message.content) ? message.content : []));
      continue;
    }
    if (pendingToolResultMedia.length > 0 && message?.role !== "tool") {
      flushToolResultMedia();
    }
    const previous = merged.at(-1);
    if (previous?.role === "assistant" && message?.role === "assistant") {
      if (previous.content === null && message.content !== null) {
        previous.content = message.content;
      } else if (previous.content !== null && message.content !== null) {
        previous.content = [previous.content, message.content].filter(Boolean).join("\n");
      }
      if (message.tool_calls?.length) {
        previous.tool_calls = [...(previous.tool_calls ?? []), ...message.tool_calls];
      }
      const prevThinking = previous.thinking || previous.reasoning || previous.reasoning_content || "";
      const msgThinking = message.thinking || message.reasoning || message.reasoning_content || "";
      const mergedThinking = [prevThinking, msgThinking].filter(Boolean).join("\n");
      if (mergedThinking) {
        previous.thinking = mergedThinking;
        previous.reasoning = mergedThinking;
        previous.reasoning_content = mergedThinking;
      }
      if (message.refusal && !previous.refusal) {
        previous.refusal = message.refusal;
      }
      continue;
    }
    if (
      previous?.role === "user" &&
      message?.role === "user" &&
      Array.isArray(previous.content) &&
      Array.isArray(message.content)
    ) {
      previous.content.push(...message.content);
      continue;
    }
    if (
      previous?.role === "user" &&
      message?.role === "user" &&
      Array.isArray(previous.content) &&
      typeof message.content === "string" &&
      message.content
    ) {
      previous.content.unshift({ type: "text", text: message.content });
      continue;
    }
    if (
      previous?.role === "user" &&
      message?.role === "user" &&
      typeof previous.content === "string" &&
      Array.isArray(message.content)
    ) {
      message.content.unshift({ type: "text", text: previous.content });
      merged[merged.length - 1] = { ...message };
      continue;
    }
    merged.push(message);
  }
  flushToolResultMedia();
  return merged;
}

export function denormalizeToOpenAIResponsesRequest(request: NormalizedRequest): OpenAIResponsesRequest {
  const reasoningEffort = request.reasoningEffort ?? normalizeReasoningEffortFromBudget(request.thinkingBudgetTokens);
  const instructionLines: string[] = [];
  let index = 0;
  while (index < request.messages.length) {
    const message = request.messages[index];
    if (message.role === "system" || message.role === "developer") {
      instructionLines.push(collapseText(requireTextOnly(message.parts, "Responses instructions")));
      index += 1;
      continue;
    }
    break;
  }

  const allParts = request.messages.flatMap((message) => message.parts);
  const webSearchContext = { snippets: collectCitedSnippets(allParts), titles: collectCitationTitles(allParts) };
  const hasWebSearchTool = request.tools?.some((tool) => tool.kind === "web_search") ?? false;

  return {
    model: request.model,
    instructions: instructionLines.length > 0 ? instructionLines.join("\n") : undefined,
    input: request.messages.slice(index).flatMap((message) => denormalizeOpenAIResponsesMessage(message, request.sourceFormat === "openai-responses", webSearchContext)) as any,
    // Without sources a converted search result would have no URLs.
    ...(hasWebSearchTool ? { include: ["web_search_call.action.sources" as const] } : {}),
    max_output_tokens: request.maxOutputTokens,
    // metadata: request.metadata ?? undefined,
    service_tier: normalizeOpenAIResponsesServiceTier(request.serviceTier),
    stream: request.stream,
    temperature: request.temperature ?? undefined,
    top_p: request.topP ?? undefined,
    parallel_tool_calls: request.parallelToolCalls,
    prompt_cache_key: request.promptCacheKey,
    prompt_cache_retention: (normalizePromptCacheRetention(request.promptCacheRetention) ?? undefined) as OpenAIResponsesRequest["prompt_cache_retention"],
    safety_identifier: request.safetyIdentifier,
    reasoning: reasoningEffort ? { effort: reasoningEffort as never } : undefined,
    text: request.responseFormat || request.textVerbosity ? { format: request.responseFormat ? denormalizeOpenAIResponsesFormat(request.responseFormat) : undefined, verbosity: request.textVerbosity ?? undefined } : undefined,
    tools: denormalizeOpenAIResponsesTools(request.tools),
    tool_choice: denormalizeOpenAIResponsesToolChoice(request.toolChoice),
  };
}

export function denormalizeToAnthropicRequest(request: NormalizedRequest, options?: AnthropicRequestConversionOptions): MessageCreateParamsBase {
  const systemBlocks: { type: "text"; text: string }[] = [];
  const filteredMessages: NormalizedMessage[] = [];
  const maxTokens = request.maxOutputTokens ?? options?.defaultMaxOutputTokens ?? 128000;
  const ignoreInvalidHistory = options?.ignoreInvalidHistory ?? true;
  
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      for (const part of requireTextOnly(message.parts, "Anthropic [REDACTED]")) systemBlocks.push({ type: "text", text: part.text });
    } else {
      filteredMessages.push(message);
    }
  }

  const anthropicMessages =
    request.sourceFormat === "anthropic"
      ? filteredMessages
      : ensureAnthropicMessagesEndWithUser(reorderMessagesForAnthropicToolResults(filteredMessages));
  const citationTitles = collectCitationTitles(request.messages.flatMap((message) => message.parts));
  const messages = mergeAnthropicMessages(anthropicMessages.flatMap((message) => denormalizeAnthropicMessage(message, request.sourceFormat === "anthropic", ignoreInvalidHistory, citationTitles)));
  const cacheControl = request.cacheControl ?? { type: "ephemeral" };
  const tools = request.tools?.flatMap((tool) => {
    if (tool.kind === "function") return [denormalizeAnthropicTool(tool)];
    const webSearchTool = tool.kind === "web_search" ? denormalizeAnthropicWebSearchTool(tool) : undefined;
    return webSearchTool ? [webSearchTool as unknown as ToolUnion] : [];
  });

  return {
    model: request.model,
    max_tokens: maxTokens,
    system: systemBlocks.length > 0 ? systemBlocks : undefined,
    messages: request.responseFormat?.type === "json_object" ? appendAnthropicJsonObjectInstruction(messages, cacheControl) : messages,
    metadata: denormalizeAnthropicMetadata(request.metadata),
    service_tier: normalizeAnthropicServiceTier(request.serviceTier),
    stream: request.stream,
    stop_sequences: request.stopSequences,
    temperature: request.temperature ?? undefined,
    top_p: request.topP ?? undefined,
    tools,
    tool_choice: denormalizeAnthropicToolChoice(request.toolChoice, request.parallelToolCalls, (tools?.length ?? 0) > 0),
    output_config: denormalizeAnthropicOutputConfig(request.responseFormat, request.reasoningEffort, request.thinkingBudgetTokens),
    thinking: denormalizeAnthropicThinking(request.reasoningEffort, request.thinkingBudgetTokens),
    cache_control: cacheControl,
  };
}

function normalizeOpenAIChatMessage(message: any): NormalizedMessage[] {
  switch (message.role) {
    case "system":
    case "developer":
      return [{ role: message.role, parts: [text(typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text).join("\n"))] }];
    case "user":
      return [{ role: "user", parts: normalizeOpenAIChatUserParts(message.content) }];
    case "assistant":
      return [{ role: "assistant", parts: normalizeOpenAIChatAssistantParts(message), toolCalls: [...(message.tool_calls?.map((toolCall: any) => normalizeOpenAIChatToolCall(toolCall)) ?? []), ...(message.function_call ? [{ kind: "function", id: `${message.function_call.name}:legacy`, name: message.function_call.name, payload: message.function_call.arguments }] : [])] }];
    case "tool":
      return [{ role: "tool", toolCallId: message.tool_call_id, parts: normalizeOpenAIChatToolResultParts(message.content) }];
    case "function":
      return [{ role: "function", name: message.name, parts: message.content ? [text(message.content)] : [] }];
    default:
      fail(`Unsupported chat role "${message.role}"`);
  }
}

function normalizeOpenAIChatToolResultParts(content: any): NormalizedMessage["parts"] {
  if (typeof content === "string") return [text(content)];
  return content.map((part: any) => {
    if (part.type === "text") return text(part.text);
    if (part.type === "image_url") return { type: "image_url", url: part.image_url.url, detail: part.image_url.detail };
    if (part.type === "input_audio") return { type: "input_audio", data: part.input_audio.data, format: part.input_audio.format };
    if (part.type === "refusal") return refusal(part.refusal);
    if (part.type === "file") rejectFileContent('Chat "file" content');
    fail(`Unsupported chat tool content part "${part.type}"`);
  });
}

function normalizeOpenAIChatUserParts(content: any): NormalizedMessage["parts"] {
  if (typeof content === "string") return [text(content)];
  return content.map((part: any) => {
    if (part.type === "text") return text(part.text);
    if (part.type === "image_url") return { type: "image_url", url: part.image_url.url, detail: part.image_url.detail };
    if (part.type === "input_audio") return { type: "input_audio", data: part.input_audio.data, format: part.input_audio.format };
    if (part.type === "file") rejectFileContent('Chat "file" content');
    fail(`Unsupported chat user content part "${part.type}"`);
  });
}

function normalizeOpenAIChatAssistantParts(message: any): NormalizedMessage["parts"] {
  const parts: NormalizedMessage["parts"] = [];
  const thinking = message.thinking ?? message.reasoning ?? message.reasoning_content;
  if (typeof thinking === "string" && thinking) parts.push({ type: "thinking", thinking });
  if (typeof message.content === "string") parts.push(text(message.content));
  else for (const part of message.content ?? []) {
    if (part.type === "text") parts.push(text(part.text));
    else if (part.type === "thinking") parts.push({ type: "thinking", thinking: part.thinking ?? part.text, signature: part.signature });
    else if (part.type === "redacted_thinking") parts.push({ type: "redacted_thinking", data: part.data });
    else parts.push(refusal(part.refusal));
  }
  if (message.refusal) parts.push(refusal(message.refusal));
  return parts;
}

function normalizeOpenAIChatToolCall(toolCall: any) {
  return toolCall.type === "function" ? { kind: "function" as const, id: toolCall.id, name: toolCall.function.name, payload: toolCall.function.arguments } : { kind: "custom" as const, id: toolCall.id, name: toolCall.custom.name, payload: toolCall.custom.input };
}

function normalizeOpenAIChatTool(tool: any): NormalizedTool | undefined {
  return tool.type === "function"
    ? { kind: "function", name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters ?? { type: "object" }, strict: tool.function.strict ?? null }
    : undefined;
}

function normalizeOpenAIChatToolChoice(choice: any): NormalizedToolChoice | undefined {
  if (typeof choice === "string") {
    // Preserve provider extensions; the SDK only declares standard choice strings.
    return { type: choice } as NormalizedToolChoice;
  }
  if (choice.type === "function") return { type: "tool", kind: "function", name: choice.function.name };
  if (choice.type === "custom") return { type: "tool", kind: "custom", name: choice.custom.name };
  if (choice.allowed_tools) return { type: choice.allowed_tools.mode === "required" ? "required" : "auto" };
  return undefined;
}

function normalizeOpenAIChatLegacyFunctionChoice(choice: any): NormalizedToolChoice {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  return { type: "tool", kind: "function", name: choice.name };
}

function normalizeOpenAIChatResponseFormat(format: any): NormalizedRequest["responseFormat"] {
  if (!format) return undefined;
  if (format.type === "text" || format.type === "json_object") return { type: format.type };
  return { type: "json_schema", name: format.json_schema.name, schema: format.json_schema.schema, description: format.json_schema.description, strict: format.json_schema.strict ?? null };
}

function normalizeOpenAIResponsesInput(input: string | any[]): NormalizedMessage[] {
  if (typeof input === "string") return [{ role: "user", parts: [text(input)] }];

  // Searches whose original Anthropic blocks travel in a carrier; their visible copies are skipped.
  const carriedSearchIds = new Set(input.flatMap((item) => item?.type === "reasoning" ? (normalizeWebSearchCarrier(item.encrypted_content) ?? []).map((search) => search.id) : []));

  return input.flatMap((item) => {
    const itemType = item.type ?? "message";
    if (itemType === "message") return [normalizeOpenAIResponsesMessage(item)];
    if (itemType === "agent_message") return [normalizeOpenAIResponsesAgentMessage(item)];
    if (itemType === "reasoning" && isWebSearchCarrier(item.encrypted_content)) {
      const searches = normalizeWebSearchCarrier(item.encrypted_content) ?? [];
      return searches.length > 0 ? [{ role: "assistant", parts: searches }] : [];
    }
    if (itemType === "web_search_call") {
      const search = normalizeResponsesWebSearch(item);
      return search.origin === "anthropic" && carriedSearchIds.has(search.id) ? [] : [{ role: "assistant", parts: [search] }];
    }
    if (itemType === "reasoning") {
      // Thinking nanollm converted from another protocol comes back intact (with its
      // signature) even when the client dropped the summary.
      const carried = decodeReasoningCarrier(item.encrypted_content);
      if (carried) return [{
        role: "assistant",
        parts: carried.redactedThinking !== undefined
          ? [{ type: "redacted_thinking", data: carried.redactedThinking, origin: "anthropic" }]
          : [{ type: "thinking", thinking: carried.thinking, signature: carried.signature }],
      }];
      // Same priority as the response side: raw reasoning text first, summary as fallback.
      const reasoningParts = Array.isArray(item.content) && item.content.length > 0 ? item.content : Array.isArray(item.summary) ? item.summary : [];
      const thinking = reasoningParts.map((part: any) => ({ type: "thinking" as const, thinking: part.text }));
      // Native encrypted reasoning is independent of any readable content or summary.
      const redactedThinking = item.encrypted_content && !isReasoningCarrier(item.encrypted_content) ? [{ type: "redacted_thinking" as const, data: item.encrypted_content, origin: "openai-responses" as const }] : [];
      return [{
        role: "assistant",
        parts: [...thinking, ...redactedThinking],
        responsesReasoning: {
          ...(typeof item.id === "string" ? { id: item.id } : {}),
          textField: Array.isArray(item.content) && item.content.length > 0 ? "content" : "summary",
        },
      }];
    }
    if (itemType === "function_call") {
      return [{
        role: "assistant",
        parts: [],
        toolCalls: [{ kind: "function", id: item.call_id, name: qualifyOpenAIResponsesToolName(item.name, item.namespace), payload: item.arguments }],
      }];
    }
    if (itemType === "custom_tool_call") {
      const name = qualifyOpenAIResponsesToolName(item.name, item.namespace);
      markResponsesCustomToolName(name);
      return [{ role: "assistant", parts: [], toolCalls: [{ kind: "function", id: item.call_id, name, payload: normalizeCustomToolInputToFunctionArguments(item.input) }] }];
    }
    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      return [{ role: "tool", toolCallId: item.call_id, parts: normalizeOpenAIResponsesToolOutput(item.output) }];
    }
    if (itemType === "tool_search_call" || itemType === "tool_search_output") {
      console.warn(`Dropping unsupported Responses input item type "${itemType}" during conversion`);
      return [];
    }
    if (itemType === "additional_tools") return [];
    if (itemType === "item_reference") return [];
    fail(`Responses input item type "${itemType}" is not supported`);
  });
}

function normalizeOpenAIResponsesAgentMessage(item: any): NormalizedMessage {
  const content = Array.isArray(item.content)
    ? item.content
        .flatMap((part: any) => {
          if (part.type === "input_text" && typeof part.text === "string") return [part.text];
          if (part.type === "encrypted_content" && typeof part.encrypted_content === "string") return [part.encrypted_content];
          return [];
        })
        .join("\n")
    : "";
  const header = [
    `Delegated message from ${item.author ?? "unknown"}`,
    `Target agent: ${item.recipient ?? "unknown"}`,
  ].join("\n");

  return { role: "developer", parts: [text(content ? `${header}\n${content}` : header)] };
}

function normalizeCustomToolInputToFunctionArguments(input: any): string {
  return wrapResponsesCustomToolInput(input);
}

function normalizeOpenAIResponsesMessage(item: any): NormalizedMessage {
  if (typeof item.content === "string") return { role: item.role, parts: [text(item.content)] };
  return {
    role: item.role,
    parts: item.content.map((part: any) => {
      if (part.type === "input_text") return text(part.text);
      if (part.type === "output_text") {
        const citations = normalizeResponsesAnnotations(part.annotations);
        return citations ? { type: "text", text: part.text, citations } : text(part.text);
      }
      if (part.type === "refusal") return refusal(part.refusal);
      if (part.type === "input_image") {
        if (!part.image_url) fail("Responses input_image without image_url is not supported");
        return { type: "image_url", url: part.image_url, detail: part.detail === "original" ? "auto" : part.detail ?? undefined };
      }
      if (part.type === "input_audio") return { type: "input_audio", data: part.input_audio.data, format: part.input_audio.format };
      if (part.type === "input_file") rejectFileContent('Responses "input_file" content');
      fail(`Unsupported Responses content part "${part.type}"`);
    }),
  };
}

function normalizeOpenAIResponsesToolOutput(output: any): NormalizedMessage["parts"] {
  if (typeof output === "string") return [text(output)];
  return output.map((part: any) => {
    if (part.type === "input_text") return text(String(part.text));
    if (part.type === "input_image") {
      if (!part.image_url) fail("Responses tool output input_image without image_url is not supported");
      return { type: "image_url", url: part.image_url, detail: part.detail === "original" ? "auto" : part.detail ?? undefined };
    }
    if (part.type === "input_file") rejectFileContent('Responses "input_file" tool output');
    fail(`Unsupported Responses tool output part "${part.type}"`);
  });
}

function normalizeOpenAIResponsesTool(tool: any, namespace?: string): NormalizedTool[] {
  if (tool.type === "namespace") {
    const qualifiedNamespace = joinOpenAIResponsesNamespacePath(tool.name, namespace);
    return (tool.tools ?? []).flatMap((child: any) => normalizeOpenAIResponsesTool(child, qualifiedNamespace));
  }

  if (isResponsesWebSearchTool(tool)) return [normalizeResponsesWebSearchTool(tool)];

  const name = qualifyOpenAIResponsesToolName(tool.name, namespace);

  if (tool.type === "function") return [{ kind: "function", name, description: tool.description, inputSchema: tool.parameters ?? { type: "object" }, strict: tool.strict ?? null }];
  if (tool.type === "custom") {
    markResponsesCustomToolName(name);
    return [{
      kind: "function",
      name,
      description: tool.description,
      inputSchema: createResponsesCustomToolSchema(tool.format),
      strict: null,
    }];
  }
  return [];
}

function normalizeOpenAIResponsesToolChoice(choice: any): NormalizedToolChoice | undefined {
  if (typeof choice === "string") {
    // Preserve provider extensions; the SDK only declares standard choice strings.
    return { type: choice } as NormalizedToolChoice;
  }
  if (choice.type === "function") return { type: "tool", kind: "function", name: choice.name };
  if (choice.type === "custom") {
    markResponsesCustomToolName(choice.name);
    return { type: "tool", kind: "function", name: choice.name };
  }
  if (choice.type === "allowed_tools") return { type: choice.mode === "required" ? "required" : "auto" };
  if (isResponsesWebSearchTool(choice)) return { type: "tool", kind: "web_search", name: WEB_SEARCH_TOOL_NAME };
  return undefined;
}

function normalizeOpenAIResponsesFormat(format: any): NormalizedRequest["responseFormat"] {
  if (!format) return undefined;
  if (format.type === "text" || format.type === "json_object") return { type: format.type };
  return { type: "json_schema", name: format.name, schema: format.schema, description: format.description, strict: format.strict ?? null };
}

function normalizeAnthropicSystem(system: any): NormalizedMessage {
  return typeof system === "string" ? { role: "system", parts: [text(system)] } : { role: "system", parts: system.map((block: any) => text(block.text)) };
}

function normalizeAnthropicMessage(message: MessageParam, searches: AnthropicSearchIndex): NormalizedMessage[] {
  // Compatible Messages providers may also send system messages in the messages array.
  const role = message.role as string;
  if (role === "system") {
    return [{ ...normalizeAnthropicSystem(message.content), role }];
  }
  if (typeof message.content === "string") return [{ role: message.role, parts: [text(message.content)] }];
  if (message.role === "assistant") {
    const parts: NormalizedMessage["parts"] = [];
    const toolCalls: NonNullable<NormalizedMessage["toolCalls"]> = [];
    // A search stays at its server_tool_use position; its result block follows later in the content.
    const sameMessageIds = new Set<string>();
    for (const block of message.content as any[]) {
      if (block.type === "text") {
        const citations = normalizeAnthropicCitations(block.citations);
        parts.push(citations ? { type: "text", text: block.text, citations } : text(block.text));
      }
      else if (block.type === "thinking") parts.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      else if (block.type === "redacted_thinking") parts.push({ type: "redacted_thinking", data: block.data, origin: "anthropic" });
      else if (block.type === "server_tool_use" && block.name === WEB_SEARCH_TOOL_NAME) {
        parts.push(startAnthropicWebSearch(block, searches, sameMessageIds));
      }
      else if (block.type === "web_search_tool_result") {
        const continuation = attachAnthropicWebSearchResult(block, searches, sameMessageIds);
        if (continuation) parts.push(continuation);
      }
      else if (block.type === "tool_use" || block.type === "server_tool_use") toolCalls.push({ kind: "function", id: block.id, name: block.name, payload: JSON.stringify(block.input) });
    }
    return [{ role: "assistant", parts, toolCalls }];
  }
  const normalized: NormalizedMessage[] = [];
  for (const block of message.content as any[]) {
    if (block.type === "text") {
      normalized.push({ role: "user", parts: [{ type: "text", text: block.text, cacheControl: block.cache_control }] });
      continue;
    }
    if (block.type === "image") {
      normalized.push({ role: "user", parts: [{ type: "image_url", url: block.source.type === "url" ? block.source.url : makeDataUrl(block.source.media_type, block.source.data), cacheControl: block.cache_control }] });
      continue;
    }
    if (block.type === "document") {
      // Plain-text documents are just text; url/base64/file sources are files and are not converted.
      if (block.source.type === "text") normalized.push({ role: "user", parts: [{ type: "text", text: block.source.data, cacheControl: block.cache_control }] });
      else if (block.source.type === "content") {
        const textParts: NormalizedMessage["parts"] = [];
        for (const child of block.source.content) {
          if (child.type !== "text") fail(`Anthropic document content block "${child.type}" is not supported`);
          textParts.push({ type: "text", text: child.text, cacheControl: block.cache_control });
        }
        if (textParts.length > 0) normalized.push({ role: "user", parts: textParts });
      }
      else rejectFileContent(`Anthropic "document" content with a "${block.source.type}" source`);
      continue;
    }
    if (block.type === "container_upload") rejectFileContent('Anthropic "container_upload" content');
    if (block.type === "tool_result") {
      normalized.push({ role: "tool", toolCallId: block.tool_use_id, isError: block.is_error, parts: normalizeAnthropicToolResultParts(block.content) });
      continue;
    }
    // Anthropic puts search results in assistant content; one in a user message still completes its search.
    if (block.type === "web_search_tool_result" && searches.has(block.tool_use_id)) {
      const entry = searches.get(block.tool_use_id)!;
      const completed = normalizeAnthropicWebSearch(entry.serverToolUse, block);
      Object.assign(entry.part, completed);
      continue;
    }
    if (isAnthropicServerToolResultBlock(block)) {
      normalized.push({ role: "tool", toolCallId: block.tool_use_id, isError: isAnthropicServerToolErrorContent(block.content), parts: normalizeAnthropicServerToolResultParts(block.content) });
      continue;
    }
    fail(`Anthropic block "${block.type}" is not supported`);
  }
  return normalized;
}

function isAnthropicServerToolResultBlock(block: any): boolean {
  return typeof block?.type === "string" && block.type.endsWith("_tool_result");
}

function isAnthropicServerToolErrorContent(content: any): boolean {
  return !!content && !Array.isArray(content) && typeof content.type === "string" && content.type.endsWith("_error");
}

function normalizeAnthropicServerToolResultParts(content: any): NormalizedMessage["parts"] {
  if (!content) return [];
  if (typeof content === "string") return [text(content)];
  if (Array.isArray(content)) {
    return content.flatMap((block: any) => normalizeAnthropicServerToolResultParts(block));
  }

  if (content.type === "web_search_result") {
    return [text([content.title, content.url, content.page_age ?? null].filter(Boolean).join("\n"))];
  }

  if (content.type === "web_fetch_result") {
    // A fetched web page is a text document; a fetched PDF is a file, so only its URL is kept.
    const source = content.content?.source;
    if (source?.type === "text" && typeof source.data === "string") return [text(source.data)];
    return [text(content.url ?? "web_fetch_result")];
  }

  if (content.type === "tool_search_tool_search_result") {
    return [text((content.tool_references ?? []).map((tool: any) => tool.tool_name).join("\n"))];
  }

  return [text(JSON.stringify(content))];
}

function normalizeAnthropicToolResultParts(content: any): NormalizedMessage["parts"] {
  if (!content) return [];
  if (typeof content === "string") return [text(content)];
  return content.map((block: any) => {
    if (block.type === "text") return text(block.text);
    if (block.type === "image") return { type: "image_url", url: block.source.type === "url" ? block.source.url : makeDataUrl(block.source.media_type, block.source.data) };
    if (block.type === "document") {
      if (block.source.type === "text") return text(block.source.data);
      rejectFileContent(`Anthropic "document" tool_result content with a "${block.source.type}" source`);
    }
    // ToolSearch results list the tools it loaded as tool_reference blocks; keep their names like tool_search_tool_search_result does.
    if (block.type === "tool_reference") return text(block.tool_name);
    fail(`Anthropic tool_result block "${block.type}" is not supported`);
  });
}

function normalizeAnthropicTool(tool: ToolUnion): NormalizedTool | undefined {
  if (isAnthropicWebSearchTool(tool)) return normalizeAnthropicWebSearchTool(tool);
  if (!("input_schema" in tool)) return undefined;
  const toolType: unknown = "type" in tool ? tool.type : undefined;
  if (toolType != null && toolType !== "custom" && toolType !== "function") return undefined;
  return {
    kind: "function",
    name: tool.name,
    description: "description" in tool ? tool.description : undefined,
    inputSchema: tool.input_schema ?? { type: "object" },
    strict: "strict" in tool ? tool.strict ?? null : null,
  } as NormalizedTool;
} 

function filterUnsupportedToolChoice(choice: NormalizedToolChoice | undefined, tools: Array<Pick<NormalizedTool, "kind" | "name">> | undefined): NormalizedToolChoice | undefined {
  if (!choice || choice.type !== "tool") return choice;
  if (!tools?.some((tool) => tool.kind === choice.kind && tool.name === choice.name)) return undefined;
  return choice;
}

function normalizeAnthropicToolChoice(choice: ToolChoice, tools: NormalizedTool[] | undefined): NormalizedToolChoice {
  switch (choice.type) {
    case "auto":
      return { type: "auto", disableParallel: choice.disable_parallel_tool_use };
    case "any":
      return { type: "required", disableParallel: choice.disable_parallel_tool_use };
    case "none":
      return { type: "none" };
    case "tool": {
      const kind = tools?.some((tool) => tool.kind === "web_search" && tool.name === choice.name) ? "web_search" : "function";
      return { type: "tool", kind, name: choice.name, disableParallel: choice.disable_parallel_tool_use };
    }
  }
}

function denormalizeOpenAIChatMessage(message: NormalizedMessage, imageEnabled: boolean, citationTitles: Map<string, string>): OpenAIChatRequest["messages"] {
  switch (message.role) {
    case "system":
      return [{ role: "system", content: collapseText(requireTextOnly(message.parts, "Chat system message")) }];
    case "developer":
      return [{ role: "system", content: collapseText(requireTextOnly(message.parts, "Chat developer message")) }];
    case "user":
      return [{ role: "user", content: denormalizeOpenAIChatUserParts(message.parts, imageEnabled) }];
    case "assistant": {
      let content = denormalizeOpenAIChatAssistantParts(message.parts, citationTitles);
      const toolCalls = message.toolCalls?.map((toolCall) => denormalizeOpenAIChatToolCall(toolCall)) as any[] | undefined;
      const thinking = message.parts.filter((part) => part.type === "thinking").map((part) => part.thinking).filter(Boolean).join("\n");
      if (content === null && thinking) content = "";
      if (content === null && (!toolCalls || toolCalls.length === 0)) return [];
      return [{
        role: "assistant",
        content,
        refusal: message.parts.find((part) => part.type === "refusal")?.text ?? null,
        ...(thinking ? { thinking, reasoning: thinking, reasoning_content: thinking } : {}),
        // DeepSeek-compatible string-only chat mode may reject assistant history
        // without a reasoning_content field, so keep an empty placeholder when
        // model.image is false and there is no preserved thinking text.
        ...(!imageEnabled && !thinking ? { reasoning_content: "", reasoning: "", thinking: "" } : {}),
        tool_calls: toolCalls?.length ? toolCalls : null,
      }];
    }
    case "tool":
      return denormalizeOpenAIChatToolResultMessage(message, message.toolCallId ?? "tool", undefined, imageEnabled);
    case "function":
      return denormalizeOpenAIChatToolResultMessage(message, message.name ?? "function", message.name, imageEnabled);
  }
}

function denormalizeOpenAIChatUserParts(parts: NormalizedMessage["parts"], imageEnabled: boolean): any {
  const preserveImages = imageEnabled && parts.some((part) => part.type === "image_url");
  if (preserveImages) {
    return parts.map((part) => denormalizeOpenAIChatUserPart(part, true));
  }
  return parts.map((part) => stringifyOpenAIChatPart(part, "Chat user message")).filter(Boolean).join("\n");
}

function denormalizeOpenAIChatAssistantParts(parts: NormalizedMessage["parts"], citationTitles: Map<string, string>): any {
  if (parts.length === 0) return null;
  const chatParts = parts.flatMap<any>((part) => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "refusal") return [{ type: "refusal", refusal: part.text }];
    if (part.type === "web_search") return part.continuation ? [] : [{ type: "text", text: webSearchNoteText(part, citationTitles) }];
    return [];
  });
  if (chatParts.length === 0) return null;
  if (chatParts.every((part) => part.type === "text")) return chatParts.map((part) => part.text).join("\n");
  return chatParts;
}

function denormalizeOpenAIChatToolCall(toolCall: NonNullable<NormalizedMessage["toolCalls"]>[number]): any {
  return toolCall.kind === "function" ? { id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.payload } } : { id: toolCall.id, type: "custom", custom: { name: toolCall.name, input: toolCall.payload } };
}

function denormalizeOpenAIChatToolResultMessage(message: NormalizedMessage, identifier: string, legacyFunctionName?: string, imageEnabled = true): OpenAIChatRequest["messages"] {
  if (message.parts.every((part) => part.type === "text" || part.type === "refusal")) {
    const content = collapseText(requireTextOnly(message.parts, legacyFunctionName ? "Chat function result" : "Chat tool result"));
    return legacyFunctionName
      ? [{ role: "function", name: legacyFunctionName, content }]
      : [{ role: "tool", tool_call_id: message.toolCallId ?? "", content }];
  }

  if (imageEnabled && message.parts.some((part) => part.type === "image_url")) {
    const textContent = message.parts
      .filter((part) => part.type === "text" || part.type === "refusal")
      .map((part) => (part as { type: "text" | "refusal"; text: string }).text)
      .join("\n");
    const toolContent = textContent || "[multimedia tool result returned separately]";
    const imageContent = message.parts
      .filter((part) => part.type === "image_url")
      .map((part) => denormalizeOpenAIChatUserPart(part, true));
    return [
      legacyFunctionName
        ? { role: "function", name: legacyFunctionName, content: toolContent }
        : { role: "tool", tool_call_id: message.toolCallId ?? "", content: toolContent },
      ...(imageContent.length > 0 ? [Object.assign({ role: "user" as const, content: imageContent }, { __toolResultMedia: true })] : []),
    ];
  }
  // image=false fallback: keep tool/function role, drop multimedia content to avoid
  // huge base64 data URLs inflating context and breaking strict API role gateways.
  const textContent = message.parts
    .filter((part) => part.type === "text" || part.type === "refusal")
    .map((part) => (part as { type: "text" | "refusal"; text: string }).text)
    .join("\n");
  const tag = (ptype: string) =>
    ptype === "image_url" ? "image" :
    ptype === "input_audio" ? "audio" : ptype;
  const omittedTypes = [...new Set(message.parts.filter((p) => p.type !== "text" && p.type !== "refusal").map((p) => tag(p.type)))];
  const omittedNote = omittedTypes.length > 0 ? `\n[${omittedTypes.join(", ")} content omitted - not supported by current model]` : "";
  const content = (textContent + omittedNote) || `Tool result for ${identifier}: [multimedia content omitted - not supported by current model]`;
  return legacyFunctionName
    ? [{ role: "function", name: legacyFunctionName, content }]
    : [{ role: "tool", tool_call_id: message.toolCallId ?? "", content }];
}

function denormalizeOpenAIChatUserPart(part: NormalizedMessage["parts"][number], preserveImages: boolean): any {
  if (part.type === "text" || part.type === "refusal") return { type: "text", text: part.text };
  if (part.type === "image_url" && preserveImages) return { type: "image_url", image_url: { url: part.url, detail: part.detail } };
  return { type: "text", text: stringifyOpenAIChatPart(part, "Chat user message") };
}

function stringifyOpenAIChatPart(part: NormalizedMessage["parts"][number], context: string): string {
  if (part.type === "text" || part.type === "refusal") return part.text;
  if (part.type === "image_url") return part.detail ? `Attached image: ${part.url} (detail: ${part.detail})` : `Attached image: ${part.url}`;
  if (part.type === "input_audio") return `Attached audio (${part.format})`;
  if (part.type === "thinking" || part.type === "redacted_thinking") return "";
  fail(`${context} cannot stringify unsupported content`);
}

function denormalizeOpenAIResponsesToolOutput(parts: NormalizedMessage["parts"], context: string): any {
  const outputParts = parts.map((part) => {
    if (part.type === "text" || part.type === "refusal") return { type: "input_text", text: part.text };
    if (part.type === "image_url") return { type: "input_image", image_url: part.url, detail: part.detail };
    fail(`${context} does not support part "${part.type}"`);
  });

  return outputParts.every((part) => part.type === "input_text") ? outputParts.map((part) => part.text).join("\n") : outputParts;
}

function denormalizeOpenAIResponsesMessage(
  message: NormalizedMessage,
  preserveThinking: boolean,
  webSearchContext: { snippets: Map<string, string[]>; titles: Map<string, string> },
): any[] {
  switch (message.role) {
    case "system":
    case "developer":
    case "user": {
      const contentParts = message.parts
        .filter((part) => part.type !== "thinking" && part.type !== "redacted_thinking" && part.type !== "web_search")
        .map((part) => {
          if (part.type === "text") return { type: "input_text", text: part.text };
          if (part.type === "refusal") return { type: "refusal", refusal: part.text };
          if (part.type === "image_url") return { type: "input_image", image_url: part.url, detail: part.detail };
          return { type: "input_audio", input_audio: { data: part.data, format: part.format } };
        });
      
      return contentParts.length > 0 ? [{ type: "message", role: message.role === "system" ? "developer" : message.role, content: contentParts }] : [];
    }
    case "assistant": {
      const thinking = message.parts.filter((part) => part.type === "thinking");
      // Opaque payloads are protocol-specific. Only native Responses reasoning
      // may be replayed as encrypted_content; Claude signatures/redactions cannot.
      const encrypted = preserveThinking
        ? message.parts.filter((part) => part.type === "redacted_thinking").filter((part) => part.origin !== "anthropic")
        : [];
      const native = preserveThinking ? message.responsesReasoning : undefined;
      const reasoningItems = native
        ? [{
            type: "reasoning",
            ...(native.id ? { id: native.id } : {}),
            summary: native.textField === "summary" ? thinking.map((part) => ({ type: "summary_text", text: part.thinking })) : [],
            ...(native.textField === "content" ? { content: thinking.map((part) => ({ type: "reasoning_text", text: part.thinking })) } : {}),
            ...(encrypted[0] ? { encrypted_content: encrypted[0].data } : {}),
          }]
        : [
            ...thinking.filter((part) => part.thinking.length > 0).map((part) => ({
              type: "reasoning",
              summary: [],
              content: [{ type: "reasoning_text", text: part.thinking }],
            })),
            ...encrypted.map((part) => ({ type: "reasoning", summary: [], encrypted_content: part.data })),
          ];
      // Visible parts keep their order: a web search splits the assistant text into the
      // messages before and after it, as in native Responses output.
      const visibleItems: any[] = [];
      let contentParts: any[] = [];
      const flushContent = () => {
        if (contentParts.length === 0) return;
        visibleItems.push({ type: "message", role: "assistant", content: contentParts });
        contentParts = [];
      };
      let hasWebSearch = false;
      for (const part of message.parts) {
        if (part.type === "thinking" || part.type === "redacted_thinking") continue;
        if (part.type === "web_search") {
          hasWebSearch = true;
          flushContent();
          const native = responsesWebSearchItem(part);
          if (native) visibleItems.push(native);
          else if (!part.continuation) visibleItems.push(...webSearchFunctionCallItems(part, webSearchContext.snippets, webSearchContext.titles));
          continue;
        }
        if (part.type === "text") contentParts.push({ type: "output_text", text: part.text, annotations: denormalizeResponsesAnnotations(part.citations) });
        else if (part.type === "refusal") contentParts.push({ type: "refusal", refusal: part.text });
        else if (part.type === "image_url") contentParts.push({ type: "input_image", image_url: part.url, detail: part.detail });
        else if (part.type === "input_audio") contentParts.push({ type: "input_audio", input_audio: { data: part.data, format: part.format } });
      }

      const toolCallItems = message.toolCalls?.map((toolCall) => {
        const { name, namespace } = splitQualifiedOpenAIResponsesToolName(toolCall.name);
        const isCustom = toolCall.kind === "custom" || (toolCall.kind === "function" && isResponsesCustomToolName(toolCall.name));

        return isCustom
          ? {
              type: "custom_tool_call",
              call_id: toolCall.id,
              name,
              ...(namespace ? { namespace } : {}),
              input: toolCall.kind === "custom" ? toolCall.payload : unwrapResponsesCustomToolInput(toolCall.payload),
            }
          : {
              type: "function_call",
              call_id: toolCall.id,
              name,
              ...(namespace ? { namespace } : {}),
              arguments: toolCall.payload,
            };
      }) ?? [];
      
      // An assistant turn with only tool calls still gets its (empty) message, unless a search already split it.
      if (contentParts.length > 0 || (toolCallItems.length > 0 && !hasWebSearch)) visibleItems.push({ type: "message", role: "assistant", content: contentParts });
      return [...reasoningItems, ...visibleItems, ...toolCallItems];
    }
    case "tool":
      return [{ type: "function_call_output", call_id: message.toolCallId ?? "", output: denormalizeOpenAIResponsesToolOutput(message.parts, "Responses tool result") }];
    case "function":
      return [{ type: "function_call_output", call_id: message.name ?? "function", output: denormalizeOpenAIResponsesToolOutput(message.parts, "Responses function result") }];
  }
}

/** Only Responses citations carry a range; Anthropic block citations become plain text. */
function denormalizeResponsesAnnotations(citations: NormalizedCitation[] | undefined): any[] {
  return (citations ?? [])
    .filter((citation) => citation.startIndex !== undefined && citation.endIndex !== undefined)
    .map((citation) => ({ type: "url_citation", url: citation.url, title: citation.title ?? "", start_index: citation.startIndex, end_index: citation.endIndex }));
}

function denormalizeAnthropicMessage(message: NormalizedMessage, preserveThinking: boolean, ignoreInvalidHistory: boolean, citationTitles: Map<string, string>): MessageParam[] {
  switch (message.role) {
    case "user":
      return [{ role: "user", content: denormalizeAnthropicUserParts(message.parts) }];
    case "assistant": {
      const content = denormalizeAnthropicAssistantParts(message, preserveThinking, ignoreInvalidHistory, citationTitles);
      return content.length > 0 ? [{ role: "assistant", content }] : [];
    }
    case "tool":
      return [{ role: "user", content: [{ type: "tool_result", tool_use_id: sanitizeAnthropicToolId(message.toolCallId ?? ""), is_error: message.isError ?? false, content: denormalizeAnthropicToolResultParts(message.parts) }] as any }];
    case "function":
      // Legacy Chat function calls are normalized with id "<name>:legacy", so the result must point at the same id.
      return [{ role: "user", content: [{ type: "tool_result", tool_use_id: sanitizeAnthropicToolId(`${message.name ?? "function"}:legacy`), is_error: message.isError ?? false, content: collapseText(requireTextOnly(message.parts, "Anthropic function result")) }] as any }];
    default:
      fail(`Anthropic Messages does not support role "${message.role}" in message array`);
  }
}

// Anthropic rejects empty text blocks ("text content blocks must be non-empty"),
// e.g. the content: "" a streaming Chat client keeps for a tool-call turn.
// Drop them, unless nothing else is left to send.
function dropEmptyAnthropicText(parts: NormalizedMessage["parts"]): NormalizedMessage["parts"] {
  const kept = parts.filter((part) => !((part.type === "text" || part.type === "refusal") && part.text === ""));
  return kept.length > 0 ? kept : parts;
}

function denormalizeAnthropicUserParts(allParts: NormalizedMessage["parts"]): any {
  const parts = dropEmptyAnthropicText(allParts);
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text, cache_control: part.cacheControl };
    if (part.type === "image_url") {
      const dataUrl = parseDataUrl(part.url);
      return dataUrl ? { type: "image", source: { type: "base64", media_type: dataUrl.mediaType, data: dataUrl.data }, cache_control: part.cacheControl } : { type: "image", source: { type: "url", url: part.url }, cache_control: part.cacheControl };
    }
    fail(`Anthropic does not support user part "${part.type}"`);
  });
}

function denormalizeAnthropicAssistantParts(message: NormalizedMessage, preserveThinking: boolean, ignoreInvalidHistory: boolean, citationTitles: Map<string, string>): ContentBlockParam[] {
  const blocks = message.parts.flatMap<ContentBlockParam>((part) => {
    // Citations are dropped: Anthropic accepts text without them, and only the issuing account can verify encrypted_index.
    // Claude rejects empty and whitespace-only text blocks (a blank acknowledgement message, for one).
    if (part.type === "text" || part.type === "refusal") return part.text.trim() === "" ? [] : [{ type: "text", text: part.text, citations: null }];
    if (part.type === "web_search") {
      const native = anthropicWebSearchBlocks(part) as ContentBlockParam[] | undefined;
      if (native) return native;
      return part.continuation ? [] : [{ type: "text", text: webSearchNoteText(part, citationTitles), citations: null }];
    }
    if (part.type === "thinking") {
      if (ignoreInvalidHistory && (part.signature === undefined || part.signature === null || part.signature === "")) return [];
      return [{ type: "thinking", thinking: part.thinking, signature: part.signature ?? "" }];
    }
    if (part.type === "redacted_thinking") return part.origin === "anthropic" || (preserveThinking && part.origin === undefined) ? [{ type: "redacted_thinking", data: part.data }] : [];
    return { type: "text", text: collapseText([part]), citations: null };
  });
  for (const toolCall of message.toolCalls ?? []) {
    if (toolCall.kind !== "function") fail("Anthropic assistant output only supports function-style tool calls");
    blocks.push({ type: "tool_use", id: sanitizeAnthropicToolId(toolCall.id), caller: { type: "direct" }, name: toolCall.name, input: parseToolArguments(toolCall.payload, `Anthropic tool call "${toolCall.name}"`) });
  }
  return blocks;
}

function denormalizeAnthropicToolResultParts(allParts: NormalizedMessage["parts"]): any {
  if (allParts.every((part) => part.type === "text")) return collapseText(allParts);
  const parts = dropEmptyAnthropicText(allParts);
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image_url") {
      const dataUrl = parseDataUrl(part.url);
      return dataUrl ? { type: "image", source: { type: "base64", media_type: dataUrl.mediaType, data: dataUrl.data } } : { type: "image", source: { type: "url", url: part.url } };
    }
    fail(`Anthropic tool_result does not support part "${part.type}"`);
  });
}

// Anthropic rejects oneOf/allOf/anyOf at the top level of a tool input_schema (and $schema/$id anywhere).
// OpenAI accepts them, so Codex-issued tools (e.g. discriminated-union MCP schemas) must be rewritten here.
// Mirrors LiteLLM's flatten_top_level_schema_combinators: branches merge into one object schema.
const ANTHROPIC_TOP_LEVEL_COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;
const ANTHROPIC_META_KEYWORDS = new Set(["$schema", "$id", "$comment", "$vocabulary"]);
const ANTHROPIC_MAX_FLATTEN_DEPTH = 32;

type JsonSchemaObject = Record<string, any>;

function schemaProperties(schema: JsonSchemaObject): JsonSchemaObject {
  const properties = schema.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties) ? properties : {};
}

function schemaRequiredNames(schema: JsonSchemaObject): Set<string> {
  const required = schema.required;
  return Array.isArray(required) ? new Set(required.filter((name): name is string => typeof name === "string")) : new Set();
}

function isObjectSchema(schema: JsonSchemaObject): boolean {
  return schema.type === "object" || (schema.type === undefined && typeof schema.properties === "object" && schema.properties !== null);
}

function resolveLocalSchemaRef(root: JsonSchemaObject, ref: string): JsonSchemaObject | undefined {
  for (const [prefix, container] of [["#/$defs/", "$defs"], ["#/definitions/", "definitions"]] as const) {
    if (!ref.startsWith(prefix)) continue;
    const definitions = root[container];
    if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) return undefined;
    const target = definitions[ref.slice(prefix.length)];
    return target && typeof target === "object" && !Array.isArray(target) ? target : undefined;
  }
  return undefined;
}

function mergeableAnthropicSchemaBranch(root: JsonSchemaObject, branch: unknown, seenRefs: ReadonlySet<string>, depth: number, expandedRefs: Map<string, JsonSchemaObject | undefined>): JsonSchemaObject | undefined {
  if (!branch || typeof branch !== "object" || Array.isArray(branch) || depth > ANTHROPIC_MAX_FLATTEN_DEPTH) return undefined;
  const ref = (branch as JsonSchemaObject).$ref;
  if (typeof ref !== "string") {
    const flattened = flattenAnthropicSchemaAgainstRoot(branch as JsonSchemaObject, root, seenRefs, depth, expandedRefs);
    return ANTHROPIC_TOP_LEVEL_COMBINATORS.some((combinator) => combinator in flattened) ? undefined : flattened;
  }
  if (expandedRefs.has(ref)) return expandedRefs.get(ref);
  if (seenRefs.has(ref)) return undefined;
  const target = resolveLocalSchemaRef(root, ref);
  const expanded = target === undefined ? undefined : mergeableAnthropicSchemaBranch(root, target, new Set([...seenRefs, ref]), depth + 1, expandedRefs);
  expandedRefs.set(ref, expanded);
  return expanded;
}

function flattenAnthropicSchemaAgainstRoot(schema: JsonSchemaObject, root: JsonSchemaObject, seenRefs: ReadonlySet<string>, depth: number, expandedRefs: Map<string, JsonSchemaObject | undefined>): JsonSchemaObject {
  const branchGroups = ANTHROPIC_TOP_LEVEL_COMBINATORS
    .filter((combinator) => Array.isArray(schema[combinator]))
    .map((combinator) => [combinator, (schema[combinator] as unknown[]).map((branch) => mergeableAnthropicSchemaBranch(root, branch, seenRefs, depth + 1, expandedRefs))] as const);
  if (branchGroups.length === 0) return schema;
  if (branchGroups.some(([, group]) => group.some((branch) => branch === undefined))) return schema;

  const branches = branchGroups.flatMap(([, group]) => group as JsonSchemaObject[]);
  const objectSchema = isObjectSchema(schema) || (schema.type === undefined && branches.length > 0 && branches.every(isObjectSchema));
  if (!objectSchema) return schema;

  // Later sources win: reversed branches, then the top-level schema. Mirrors LiteLLM's simple overwrite merge.
  const mergedProperties: JsonSchemaObject = {};
  for (const source of [...branches].reverse().concat(schema)) Object.assign(mergedProperties, schemaProperties(source));

  const requiredNames = new Set(schemaRequiredNames(schema));
  for (const [combinator, group] of branchGroups) {
    const branchRequired = (group as JsonSchemaObject[]).map(schemaRequiredNames);
    if (branchRequired.length === 0) continue;
    const merged = combinator === "allOf"
      ? branchRequired.reduce((acc, names) => new Set([...acc, ...names]))
      : branchRequired.reduce((acc, names) => new Set([...acc].filter((name) => names.has(name))));
    for (const name of merged) requiredNames.add(name);
  }

  const kept = Object.fromEntries(Object.entries(schema).filter(([key]) => !(ANTHROPIC_TOP_LEVEL_COMBINATORS as readonly string[]).includes(key)));
  return {
    ...kept,
    type: "object",
    properties: mergedProperties,
    ...(requiredNames.size > 0 ? { required: [...requiredNames].sort() } : {}),
  };
}

function stripAnthropicSchemaMetaKeywords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAnthropicSchemaMetaKeywords);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonSchemaObject)
      .filter(([key]) => !ANTHROPIC_META_KEYWORDS.has(key))
      .map(([key, entry]) => [key, stripAnthropicSchemaMetaKeywords(entry)]),
  );
}

function sanitizeAnthropicInputSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const normalized = (stripAnthropicSchemaMetaKeywords(inputSchema) ?? {}) as JsonSchemaObject;
  const flattened = flattenAnthropicSchemaAgainstRoot(normalized, normalized, new Set(), 0, new Map());
  return {
    type: "object",
    ...flattened,
    properties: typeof flattened.properties === "object" && flattened.properties !== null ? flattened.properties : {},
  };
}

function denormalizeAnthropicTool(tool: NormalizedTool): ToolUnion {
  if (tool.kind !== "function") fail("Anthropic request conversion only supports function-style tools");
  return { name: tool.name, description: tool.description ?? undefined, input_schema: sanitizeAnthropicInputSchema(tool.inputSchema) as any };
}

function denormalizeAnthropicToolChoice(choice: NormalizedToolChoice | undefined, parallelToolCalls: boolean | undefined, hasTools: boolean): MessageCreateParamsBase["tool_choice"] {
  const disableParallel = parallelToolCalls === undefined ? (choice && "disableParallel" in choice ? choice.disableParallel : undefined) : !parallelToolCalls;
  if (!choice) {
    if (disableParallel === undefined || !hasTools) return undefined;
    return { type: "auto", disable_parallel_tool_use: disableParallel };
  }
  if (choice.type === "auto") return { type: "auto", disable_parallel_tool_use: disableParallel };
  if (choice.type === "required") return { type: "any", disable_parallel_tool_use: disableParallel };
  if (choice.type === "none") return { type: "none" };
  // Opus 5.5, Sonnet 5.5 and Fable 5.1 reject a forced choice, and forcing skips thinking elsewhere.
  if (choice.kind === "web_search") return hasTools ? { type: "auto", disable_parallel_tool_use: disableParallel } : undefined;
  if (choice.kind !== "function") fail("Anthropic tool_choice only supports function-style tools");
  return { type: "tool", name: choice.name, disable_parallel_tool_use: disableParallel };
}

function mergeAnthropicMessages(messages: MessageParam[]): MessageParam[] {
  const merged: MessageParam[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last && last.role === message.role) {
      const previous = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
      const next = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      last.content = [...previous, ...next] as any;
    } else {
      merged.push(message);
    }
  }
  return merged;
}

function reorderMessagesForAnthropicToolResults(messages: NormalizedMessage[]): NormalizedMessage[] {
  const used = new Array(messages.length).fill(false);
  const reordered: NormalizedMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    if (used[index]) continue;
    const message = messages[index];
    used[index] = true;
    reordered.push(message);

    const pendingToolResultIds = getAnthropicPendingToolResultIds(message);
    if (pendingToolResultIds.size === 0) continue;

    // Collect consecutive assistants that also have tool calls so their
    // results land after the entire assistant group instead of splitting it.
    let groupEnd = index;
    for (let nextIdx = index + 1; nextIdx < messages.length; nextIdx += 1) {
      if (used[nextIdx]) continue;
      const nextMsg = messages[nextIdx];
      if (nextMsg.role !== "assistant") break;
      if (nextMsg.toolCalls) {
        for (const tc of nextMsg.toolCalls) {
          if (tc.kind === "function") {
            pendingToolResultIds.add(tc.id);
            if (tc.id.endsWith(":legacy")) pendingToolResultIds.add(tc.name);
          }
        }
      }
      used[nextIdx] = true;
      reordered.push(nextMsg);
      groupEnd = nextIdx;
    }

    for (let nextIndex = groupEnd + 1; nextIndex < messages.length; nextIndex += 1) {
      if (used[nextIndex]) continue;
      const candidate = messages[nextIndex];
      const candidateToolResultId = getAnthropicToolResultId(candidate);
      if (!candidateToolResultId || !pendingToolResultIds.has(candidateToolResultId)) continue;
      used[nextIndex] = true;
      reordered.push(candidate);
      pendingToolResultIds.delete(candidateToolResultId);
      if (pendingToolResultIds.size === 0) break;
    }
  }

  return reordered;
}

function ensureAnthropicMessagesEndWithUser(messages: NormalizedMessage[]): NormalizedMessage[] {
  const last = messages.at(-1);
  if (!last || last.role === "user" || last.role === "tool" || last.role === "function") return messages;
  return [...messages, { role: "user", parts: [text("go on")] }];
}

export const ANTHROPIC_JSON_OBJECT_INSTRUCTION = "Reply with a single valid JSON object and nothing else: no Markdown code fences and no text before or after it.";

/**
 * Anthropic has no JSON mode, so json_object asks for a bare JSON object in a text block at the end of the last user message.
 * Clients never resend that block, so the block before it gets a cache breakpoint: with only the automatic breakpoint on the
 * instruction, the next turn's prompt would never match this turn's cache entry.
 */
function appendAnthropicJsonObjectInstruction(messages: MessageParam[], cacheControl: { type: "ephemeral" }): MessageParam[] {
  const index = messages.findLastIndex((message) => message.role === "user");
  if (index === -1) return messages;
  const { content } = messages[index];
  const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
  if (blocks.length > 0) blocks[blocks.length - 1] = { ...blocks.at(-1), cache_control: cacheControl };
  const result = [...messages];
  result[index] = { ...messages[index], content: [...blocks, { type: "text", text: ANTHROPIC_JSON_OBJECT_INSTRUCTION }] as any };
  return result;
}

function reorderMessagesForOpenAIChatToolResults(messages: NormalizedMessage[]): NormalizedMessage[] {
  const used = new Array(messages.length).fill(false);
  const reordered: NormalizedMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    if (used[index]) continue;
    const message = messages[index];
    used[index] = true;
    reordered.push(message);

    const pendingToolResultIds = getOpenAIChatPendingToolResultIds(message);
    if (pendingToolResultIds.size === 0) continue;

    // Collect consecutive assistants that also have tool calls so their
    // results land after the entire assistant group instead of splitting it.
    let groupEnd = index;
    for (let nextIdx = index + 1; nextIdx < messages.length; nextIdx += 1) {
      if (used[nextIdx]) continue;
      const nextMsg = messages[nextIdx];
      if (nextMsg.role !== "assistant") break;
            if (nextMsg.toolCalls) { for (const tc of nextMsg.toolCalls) pendingToolResultIds.add(tc.id); }
      used[nextIdx] = true;
      reordered.push(nextMsg);
      groupEnd = nextIdx;
    }

    for (let nextIndex = groupEnd + 1; nextIndex < messages.length; nextIndex += 1) {
      if (used[nextIndex]) continue;
      const candidate = messages[nextIndex];
      const candidateToolResultId = getOpenAIChatToolResultId(candidate);
      if (!candidateToolResultId || !pendingToolResultIds.has(candidateToolResultId)) continue;
      used[nextIndex] = true;
      reordered.push(candidate);
      pendingToolResultIds.delete(candidateToolResultId);
      if (pendingToolResultIds.size === 0) break;
    }
  }

  return reordered;
}

function getOpenAIChatPendingToolResultIds(message: NormalizedMessage): Set<string> {
  if (message.role !== "assistant" || !message.toolCalls?.length) return new Set();
  return new Set(message.toolCalls.map((tc) => tc.id));
}

function getOpenAIChatToolResultId(message: NormalizedMessage): string | undefined {
  if (message.role === "tool") return message.toolCallId ?? undefined;
  return undefined;
}

function getAnthropicPendingToolResultIds(message: NormalizedMessage): Set<string> {
  if (message.role !== "assistant" || !message.toolCalls?.length) return new Set<string>();
  const ids = message.toolCalls
    .filter((toolCall) => toolCall.kind === "function")
    .flatMap((toolCall) => (toolCall.id.endsWith(":legacy") ? [toolCall.id, toolCall.name] : [toolCall.id]));
  return new Set(ids);
}

function getAnthropicToolResultId(message: NormalizedMessage): string | undefined {
  if (message.role === "tool") return message.toolCallId ?? undefined;
  if (message.role === "function") return message.name ?? undefined;
  return undefined;
}

function normalizePromptCacheRetention(value: string | null | undefined): NormalizedRequest["promptCacheRetention"] {
  if (value == null) return null;
  if (value === "in-memory" || value === "in_memory") return "in_memory";
  return value;
}

function denormalizeAnthropicMetadata(metadata: NormalizedRequest["metadata"]) {
  return typeof metadata?.user_id === "string" && metadata.user_id ? { user_id: metadata.user_id } : undefined;
}

/** Map an OpenAI-style effort onto Anthropic: "none" means thinking off, "minimal" is below Anthropic's lowest level. */
function toAnthropicEffort(reasoningEffort: string | null | undefined, thinkingBudgetTokens: number | null | undefined): NonNullable<MessageCreateParamsBase["output_config"]>["effort"] {
  const effort = reasoningEffort ?? normalizeReasoningEffortFromBudget(thinkingBudgetTokens);
  if (effort === "none") return null;
  if (effort === "minimal") return "low";
  if (effort == null) return null;
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") return effort;
  fail(`Unsupported Anthropic reasoning effort "${effort}"`);
}

function denormalizeAnthropicOutputConfig(responseFormat: NormalizedRequest["responseFormat"], reasoningEffort: string | null | undefined, thinkingBudgetTokens: number | null | undefined) {
  const effort = toAnthropicEffort(reasoningEffort, thinkingBudgetTokens);
  const format = responseFormat?.type === "json_schema" ? { type: "json_schema" as const, schema: responseFormat.schema ?? {} } : undefined;
  if (!format && !effort) return undefined;
  return { ...(format ? { format } : {}), ...(effort ? { effort } : {}) };
}

function denormalizeAnthropicThinking(reasoningEffort: string | null | undefined, thinkingBudgetTokens: number | null | undefined) {
  if (reasoningEffort === "none") return { type: "disabled" as const };
  if (!reasoningEffort && thinkingBudgetTokens == null) return undefined;
  return { type: "adaptive" as const, display: "summarized" as const };
}

// OpenAI Chat/Responses accept auto | default | flex | scale | priority; Anthropic accepts auto | standard_only.
// Codex clients also send "fast" as an alias of priority. Values with no counterpart are omitted (upstream default).
const OPENAI_SERVICE_TIERS = new Map<string, "auto" | "default" | "flex" | "scale" | "priority">([
  ["auto", "auto"],
  ["default", "default"],
  ["flex", "flex"],
  ["scale", "scale"],
  ["priority", "priority"],
  ["fast", "priority"],
  ["standard_only", "default"],
]);

// Anthropic "auto" uses Priority Tier capacity when the org has it, so priority-like tiers map to auto;
// "standard_only" never does, so default/flex map there.
const ANTHROPIC_SERVICE_TIERS = new Map<string, "auto" | "standard_only">([
  ["auto", "auto"],
  ["priority", "auto"],
  ["fast", "auto"],
  ["scale", "auto"],
  ["default", "standard_only"],
  ["flex", "standard_only"],
  ["standard_only", "standard_only"],
]);

function normalizeOpenAIServiceTier(tier: string | null | undefined): OpenAIChatRequest["service_tier"] | undefined {
  return tier ? OPENAI_SERVICE_TIERS.get(tier.toLowerCase()) : undefined;
}

function normalizeOpenAIResponsesServiceTier(tier: string | null | undefined): OpenAIResponsesRequest["service_tier"] | undefined {
  return tier ? OPENAI_SERVICE_TIERS.get(tier.toLowerCase()) : undefined;
}

function normalizeAnthropicServiceTier(tier: string | null | undefined): MessageCreateParamsBase["service_tier"] | undefined {
  return tier ? ANTHROPIC_SERVICE_TIERS.get(tier.toLowerCase()) : undefined;
}

function denormalizeOpenAIChatResponseFormat(format: NormalizedRequest["responseFormat"]): OpenAIChatRequest["response_format"] {
  if (!format) return undefined;
  if (format.type === "text" || format.type === "json_object") return { type: format.type };
  return { type: "json_schema", json_schema: { name: format.name, description: format.description, schema: format.schema, strict: format.strict ?? undefined } };
}

function denormalizeOpenAIResponsesFormat(format: NonNullable<NormalizedRequest["responseFormat"]>) {
  if (format.type === "text" || format.type === "json_object") return { type: format.type };
  return { type: "json_schema" as const, name: format.name, description: format.description, schema: format.schema, strict: format.strict ?? undefined };
}

function denormalizeOpenAIResponsesTools(tools: NormalizedTool[] | undefined): OpenAIResponsesRequest["tools"] {
  if (!tools?.length) return undefined;

  const denormalizedTools: any[] = [];
  const namespaceTools = new Map<string, { type: "namespace"; name: string; description: string; tools: any[] }>();

  for (const tool of tools) {
    if (tool.kind === "web_search") {
      denormalizedTools.push(denormalizeResponsesWebSearchTool(tool));
      continue;
    }
    const { name, namespace } = splitQualifiedOpenAIResponsesToolName(tool.name);
    const denormalizedTool =
      tool.kind === "function"
        ? { type: "function", name, description: tool.description ?? undefined, parameters: tool.inputSchema, strict: tool.strict ?? undefined }
        : { type: "custom", name, description: tool.description ?? undefined, format: tool.format as never };

    if (!namespace) {
      denormalizedTools.push(denormalizedTool);
      continue;
    }

    let namespaceTool = namespaceTools.get(namespace);
    if (!namespaceTool) {
      namespaceTool = {
        type: "namespace",
        name: namespace,
        description: `Tools available in the ${namespace} namespace.`,
        tools: [],
      };
      namespaceTools.set(namespace, namespaceTool);
      denormalizedTools.push(namespaceTool);
    }

    namespaceTool.tools.push(denormalizedTool);
  }

  return denormalizedTools as OpenAIResponsesRequest["tools"];
}

function denormalizeOpenAIChatToolChoice(choice: NormalizedToolChoice | undefined): OpenAIChatRequest["tool_choice"] {
  if (!choice) return undefined;
  if (choice.type === "auto" || choice.type === "none" || choice.type === "required") return choice.type;
  // The web search tool itself is dropped for Chat, so there is nothing to choose.
  if (choice.kind === "web_search") return undefined;
  return choice.kind === "function" ? { type: "function", function: { name: choice.name } } : { type: "custom", custom: { name: choice.name } };
}

function denormalizeOpenAIResponsesToolChoice(choice: NormalizedToolChoice | undefined): OpenAIResponsesRequest["tool_choice"] {
  if (!choice) return undefined;
  if (choice.type === "auto" || choice.type === "none" || choice.type === "required") return choice.type;
  // Forcing web search ({type:"web_search"} or "required") makes gpt-6.1-sol loop until max_messages.
  if (choice.kind === "web_search") return "auto";
  return choice.kind === "function" ? { type: "function", name: choice.name } : { type: "custom", name: choice.name };
}
