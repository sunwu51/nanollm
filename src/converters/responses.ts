import type {
  AnthropicMessagesResponse,
  NormalizedMessage,
  NormalizedPart,
  NormalizedResponse,
  OpenAIChatResponse,
  OpenAIResponsesResponse,
} from "./shared.js";
import {
  collapseText,
  decodeReasoningCarrier,
  denormalizeUsageToAnthropic,
  denormalizeUsageToOpenAIChat,
  denormalizeUsageToOpenAIResponses,
  encodeReasoningCarrier,
  encodeRedactedReasoningCarrier,
  fail,
  isReasoningCarrier,
  normalizeUsage,
  parseToolArguments,
  qualifyOpenAIResponsesToolName,
  refusal,
  sanitizeAnthropicToolId,
  splitQualifiedOpenAIResponsesToolName,
  text,
  unwrapResponsesCustomToolInput,
  wrapResponsesCustomToolInput,
} from "./shared.js";
import {
  attachAnthropicWebSearchResult,
  collectCitationTitles,
  countWebSearchRequests,
  normalizeAnthropicCitations,
  normalizeResponsesAnnotations,
  normalizeResponsesWebSearch,
  responsesAnnotations,
  splitTextByCitations,
  startAnthropicWebSearch,
  webSearchToAnthropicBlocks,
  webSearchToResponsesItems,
  WEB_SEARCH_TOOL_NAME,
  type AnthropicSearchIndex,
} from "./web-search.js";
import { isResponsesCustomToolName } from "../core/request-context.js";

export function normalizeOpenAIChatResponse(response: OpenAIChatResponse): NormalizedResponse {
  const choice = response.choices[0];
  const message = choice?.message;
  // Some compatible gateways return content blocks instead of the standard string.
  const content = message?.content;

  return {
    id: response.id,
    createdAt: response.created,
    model: response.model,
    sourceFormat: "openai-chat",
    finishReason: choice?.finish_reason ?? null,
    message: {
      role: "assistant",
      parts: [
        ...(typeof content === "string" ? [text(content)] : Array.isArray(content)
          ? content.flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [text(part.text)]
            : part?.type === "refusal" && typeof part.refusal === "string" ? [refusal(part.refusal)] : []) : []),
        ...normalizeOpenAIChatThinkingParts(message),
        ...(message?.refusal ? [refusal(message.refusal)] : []),
      ],
      toolCalls:
        message?.tool_calls?.map((toolCall) =>
          toolCall.type === "function"
            ? { kind: "function" as const, id: toolCall.id, name: toolCall.function.name, payload: toolCall.function.arguments }
            : { kind: "custom" as const, id: toolCall.id, name: toolCall.custom.name, payload: toolCall.custom.input },
        ) ?? [],
    },
    usage: normalizeUsage(response.usage),
  };
}

export function normalizeOpenAIResponsesResponse(response: OpenAIResponsesResponse): NormalizedResponse {
  const parts: NormalizedMessage["parts"] = [];
  const toolCalls: NonNullable<NormalizedMessage["toolCalls"]> = [];

  for (const item of response.output) {
    if (item.type === "message") {
      // Some upstreams open the stream with a blank acknowledgement message ahead of the real output.
      if (response.output.length > 1 && isBlankMessage(item)) continue;
      for (const block of item.content) {
        if (block.type === "output_text") {
          const citations = normalizeResponsesAnnotations(block.annotations);
          parts.push(citations ? { type: "text", text: block.text, citations } : text(block.text));
        }
        else if (block.type === "refusal") parts.push(refusal(block.refusal));
      }
      continue;
    }

    if (item.type === "web_search_call") {
      parts.push(normalizeResponsesWebSearch(item));
      continue;
    }

    if (item.type === "function_call") {
      toolCalls.push({ kind: "function", id: item.call_id, name: qualifyOpenAIResponsesToolName(item.name, item.namespace), payload: item.arguments });
      continue;
    }

    if (item.type === "custom_tool_call") {
      toolCalls.push({
        kind: "function",
        id: item.call_id,
        name: qualifyOpenAIResponsesToolName(item.name, item.namespace),
        payload: normalizeCustomToolInputToFunctionArguments(item.input),
      });
      continue;
    }

    if (item.type === "reasoning") {
      const carried = decodeReasoningCarrier(item.encrypted_content);
      if (carried) {
        if (carried.redactedThinking !== undefined) {
          parts.push({ type: "redacted_thinking", data: carried.redactedThinking, origin: "anthropic" });
        } else {
          parts.push({ type: "thinking", thinking: carried.thinking, signature: carried.signature });
        }
        continue;
      }
      const reasoningParts = item.content?.length ? item.content : item.summary ?? [];
      for (const part of reasoningParts) {
        parts.push({ type: "thinking", thinking: part.text });
      }
      if (item.encrypted_content && !isReasoningCarrier(item.encrypted_content)) {
        parts.push({ type: "redacted_thinking", data: item.encrypted_content, origin: "openai-responses" });
      }
    }
  }

  return {
    id: response.id,
    createdAt: response.created_at,
    model: response.model,
    sourceFormat: "openai-responses",
    finishReason: toolCalls.length > 0 ? "tool_calls" : response.status === "incomplete" ? "length" : "stop",
    message: {
      role: "assistant",
      parts,
      toolCalls,
    },
    usage: normalizeUsage(response.usage),
  };
}

function isBlankMessage(item: { content: Array<{ type: string; text?: string }> }): boolean {
  return item.content.length > 0 && item.content.every((block) => block.type === "output_text" && (block.text ?? "").trim() === "");
}

function normalizeOpenAIChatThinkingParts(message: any): NormalizedMessage["parts"] {
  const thinking = message?.thinking ?? message?.reasoning ?? message?.reasoning_content;
  return typeof thinking === "string" && thinking ? [{ type: "thinking", thinking }] : [];
}

function normalizeCustomToolInputToFunctionArguments(input: any): string {
  return wrapResponsesCustomToolInput(input);
}

export function normalizeAnthropicResponse(response: AnthropicMessagesResponse): NormalizedResponse {
  const parts: NormalizedMessage["parts"] = [];
  const toolCalls: NonNullable<NormalizedMessage["toolCalls"]> = [];
  const searches: AnthropicSearchIndex = new Map();
  const searchIds = new Set<string>();

  for (const block of response.content) {
    if (block.type === "text") {
      const citations = normalizeAnthropicCitations(block.citations);
      parts.push(citations ? { type: "text", text: block.text, citations } : text(block.text));
      continue;
    }

    if (block.type === "thinking") {
      parts.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      continue;
    }

    if (block.type === "redacted_thinking") {
      parts.push({ type: "redacted_thinking", data: block.data, origin: "anthropic" });
      continue;
    }

    if (block.type === "server_tool_use" && block.name === WEB_SEARCH_TOOL_NAME) {
      parts.push(startAnthropicWebSearch(block, searches, searchIds));
      continue;
    }

    if (block.type === "web_search_tool_result") {
      const continuation = attachAnthropicWebSearchResult(block, searches, searchIds);
      if (continuation) parts.push(continuation);
      continue;
    }

    if (block.type === "tool_use" || block.type === "server_tool_use") {
      toolCalls.push({
        kind: "function",
        id: block.id,
        name: block.name,
        payload: JSON.stringify(block.input),
      });
    }
  }

  return {
    id: response.id,
    createdAt: 0,
    model: response.model,
    sourceFormat: "anthropic",
    finishReason: response.stop_reason,
    message: {
      role: "assistant",
      parts,
      toolCalls,
    },
    usage: normalizeUsage(response.usage),
  };
}

export function denormalizeToOpenAIChatResponse(response: NormalizedResponse): OpenAIChatResponse {
  const visibleParts = response.message.parts.filter((part) => part.type === "text" || part.type === "refusal");
  const thinking = response.message.parts.filter((part) => part.type === "thinking").map((part) => part.thinking).join("\n");
  const toolCalls = response.message.toolCalls?.map<import("./shared.js").ChatCompletionMessageToolCall>((toolCall) =>
    toolCall.kind === "function"
      ? { id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.payload } }
      : { id: toolCall.id, type: "custom", custom: { name: toolCall.name, input: toolCall.payload } },
  );
  return {
    id: response.id,
    object: "chat.completion",
    created: response.createdAt,
    model: response.model,
    choices: [
      {
        index: 0,
        finish_reason: normalizeChatFinishReason(response.finishReason),
        logprobs: null,
        message: {
          role: "assistant",
          content: visibleParts.length === 0 ? null : visibleParts.map((part) => (part.type === "text" ? { type: "text", text: part.text } : { type: "refusal", refusal: part.text })),
          refusal: visibleParts.find((part) => part.type === "refusal")?.text ?? null,
          ...(thinking ? { thinking, reasoning: thinking, reasoning_content: thinking } : {}),
          tool_calls: toolCalls?.length ? toolCalls : null,
        },
      },
    ],
    usage: denormalizeUsageToOpenAIChat(response.usage),
  };
}

function responsesReasoningItem(part: Extract<NormalizedPart, { type: "thinking" | "redacted_thinking" }>, index: number, response: NormalizedResponse) {
  return {
    id: `rs_${index}`,
    type: "reasoning",
    summary: part.type === "thinking" ? [{ type: "summary_text", text: part.thinking }] : [],
    encrypted_content: part.type === "thinking"
      ? encodeReasoningCarrier(part.thinking, part.signature)
      : part.origin === "anthropic" || (!part.origin && response.sourceFormat === "anthropic")
        ? encodeRedactedReasoningCarrier(part.data)
        : part.data,
    status: "completed",
  };
}

/**
 * Output with web searches: items follow the order of the parts (thinking, search, thinking, text),
 * because Claude binds thinking signatures to what precedes them. Each search splits the text around it
 * into separate message items, as in native Responses output.
 */
function orderedResponsesOutput(response: NormalizedResponse): unknown[] {
  const output: unknown[] = [];
  let content: unknown[] = [];
  let messages = 0;
  let reasoning = 0;
  const flush = () => {
    if (content.length === 0) return;
    output.push({ id: `msg_${++messages}`, type: "message", role: "assistant", status: "completed", content });
    content = [];
  };
  for (const part of response.message.parts) {
    if (part.type === "thinking" || part.type === "redacted_thinking") {
      flush();
      output.push(responsesReasoningItem(part, reasoning++, response));
    } else if (part.type === "web_search") {
      flush();
      output.push(...webSearchToResponsesItems(part));
    } else if (part.type === "text") {
      content.push({ type: "output_text", text: part.text, annotations: responsesAnnotations(part.text, part.citations) });
    } else if (part.type === "refusal") {
      content.push({ type: "refusal", refusal: part.text });
    }
  }
  flush();
  return output;
}

export function denormalizeToOpenAIResponsesResponse(response: NormalizedResponse): OpenAIResponsesResponse {
  const reasoningParts = response.message.parts.filter((part) => part.type === "thinking" || part.type === "redacted_thinking");
  const visibleParts = response.message.parts.filter((part) => part.type === "text" || part.type === "refusal");
  const hasWebSearch = response.message.parts.some((part) => part.type === "web_search");
  return {
    id: response.id,
    object: "response",
    created_at: response.createdAt,
    model: response.model,
    output_text: collapseText(visibleParts as any),
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    output: [
      ...(hasWebSearch ? orderedResponsesOutput(response) : [
      ...reasoningParts.map((part, index) => responsesReasoningItem(part, index, response)),
      ...(visibleParts.length > 0
        ? [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: visibleParts.map((part) =>
                part.type === "text"
                  ? { type: "output_text", text: part.text, annotations: responsesAnnotations(part.text, part.citations) }
                  : { type: "refusal", refusal: part.text },
              ),
            },
          ]
        : []),
      ]),
      ...(response.message.toolCalls?.map((toolCall) =>
        (() => {
          const { name, namespace } = splitQualifiedOpenAIResponsesToolName(toolCall.name);
          return toolCall.kind === "custom" || (toolCall.kind === "function" && isResponsesCustomToolName(toolCall.name))
            ? {
                id: toolCall.id,
                type: "custom_tool_call",
                call_id: toolCall.id,
                name,
                ...(namespace ? { namespace } : {}),
                input: toolCall.kind === "custom" ? toolCall.payload : unwrapResponsesCustomToolInput(toolCall.payload),
                status: "completed",
              }
            : {
                id: toolCall.id,
                type: "function_call",
                call_id: toolCall.id,
                name,
                ...(namespace ? { namespace } : {}),
                arguments: toolCall.payload,
                status: "completed",
              };
        })()
      ) ?? []),
    ] as OpenAIResponsesResponse["output"],
    parallel_tool_calls: (response.message.toolCalls?.length ?? 0) > 1,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    status: "completed",
    text: { format: { type: "text" } },
    usage: denormalizeUsageToOpenAIResponses(response.usage),
  };
}

export function denormalizeToAnthropicResponse(response: NormalizedResponse): AnthropicMessagesResponse {
  const citationTitles = collectCitationTitles(response.message.parts);
  const webSearchRequests = countWebSearchRequests(response.message.parts);
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    container: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: normalizeAnthropicStopReason(response.finishReason),
    stop_sequence: null,
    content: [
      ...response.message.parts.flatMap<AnthropicMessagesResponse["content"][number]>((part) => {
        if (part.type === "text") return splitTextByCitations(part.text, part.citations) as unknown as AnthropicMessagesResponse["content"];
        if (part.type === "refusal") return [{ type: "text" as const, text: part.text, citations: null }];
        if (part.type === "web_search") return webSearchToAnthropicBlocks(part, citationTitles) as unknown as AnthropicMessagesResponse["content"];
        if (part.type === "thinking") return [{ type: "thinking" as const, thinking: part.thinking, signature: part.signature ?? "" }];
        if (part.type === "redacted_thinking") {
          return part.origin === "anthropic" || (!part.origin && response.sourceFormat === "anthropic")
            ? [{ type: "redacted_thinking" as const, data: part.data }]
            : [];
        }
        return [{ type: "text" as const, text: collapseText([part]), citations: null }];
      }),
      ...(response.message.toolCalls?.map((toolCall) => {
        if (toolCall.kind !== "function") fail("Anthropic response conversion only supports function-style tool calls");
        return {
          type: "tool_use" as const,
          id: sanitizeAnthropicToolId(toolCall.id),
          caller: { type: "direct" as const },
          name: toolCall.name,
          input: parseToolArguments(toolCall.payload, `Anthropic tool call "${toolCall.name}"`),
        };
      }) ?? []),
    ],
    usage: {
      ...(denormalizeUsageToAnthropic(response.usage) ?? {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
      }),
      ...(webSearchRequests > 0 ? { server_tool_use: { web_search_requests: webSearchRequests, web_fetch_requests: 0 } } : {}),
    } as AnthropicMessagesResponse["usage"],
  };
}

function normalizeChatFinishReason(reason: string | null): OpenAIChatResponse["choices"][number]["finish_reason"] {
  if (reason === "tool_use" || reason === "tool_calls") return "tool_calls";
  if (reason === "max_tokens" || reason === "length") return "length";
  if (reason === "refusal") return "content_filter";
  return "stop";
}

function normalizeAnthropicStopReason(reason: string | null): AnthropicMessagesResponse["stop_reason"] {
  if (reason === "tool_calls" || reason === "tool_use") return "tool_use";
  if (reason === "length" || reason === "max_tokens") return "max_tokens";
  if (reason === "stop_sequence") return "stop_sequence";
  if (reason === "pause_turn") return "pause_turn";
  if (reason === "refusal" || reason === "content_filter") return "refusal";
  return "end_turn";
}
