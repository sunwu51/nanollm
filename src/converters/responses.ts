// @ts-nocheck
import type {
  AnthropicMessagesResponse,
  NormalizedMessage,
  NormalizedResponse,
  OpenAIChatResponse,
  OpenAIResponsesResponse,
} from "./shared.js";
import {
  collapseText,
  denormalizeUsageToAnthropic,
  denormalizeUsageToOpenAIChat,
  denormalizeUsageToOpenAIResponses,
  fail,
  normalizeUsage,
  parseJson,
  refusal,
  text,
  unwrapResponsesCustomToolInput,
  wrapResponsesCustomToolInput,
} from "./shared.js";
import { isResponsesCustomToolName } from "../request-context.js";

export function normalizeOpenAIChatResponse(response: OpenAIChatResponse): NormalizedResponse {
  const choice = response.choices[0];
  const message = choice?.message;

  return {
    id: response.id,
    createdAt: response.created,
    model: response.model,
    sourceFormat: "openai-chat",
    finishReason: choice?.finish_reason ?? null,
    message: {
      role: "assistant",
      parts: [
        ...(typeof message?.content === "string"
          ? [text(message.content)]
          : message?.content?.map((part) => (part.type === "text" ? text(part.text) : refusal(part.refusal))) ?? []),
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
    usage: normalizeUsage(response.usage as Record<string, unknown> | undefined),
  };
}

export function normalizeOpenAIResponsesResponse(response: OpenAIResponsesResponse): NormalizedResponse {
  const parts: NormalizedMessage["parts"] = [];
  const toolCalls: NonNullable<NormalizedMessage["toolCalls"]> = [];

  for (const item of response.output) {
    if (item.type === "message") {
      for (const block of item.content) {
        if (block.type === "output_text") parts.push(text(block.text));
        else if (block.type === "refusal") parts.push(refusal(block.refusal));
      }
      continue;
    }

    if (item.type === "function_call") {
      toolCalls.push({ kind: "function", id: item.call_id, name: item.name, payload: item.arguments });
      continue;
    }

    if (item.type === "custom_tool_call") {
      toolCalls.push({ kind: "function", id: item.call_id, name: item.name, payload: normalizeCustomToolInputToFunctionArguments(item.input) });
      continue;
    }

    if (item.type === "reasoning") {
      for (const part of item.content ?? []) {
        parts.push({ type: "thinking", thinking: part.text });
      }
      for (const part of item.summary ?? []) {
        parts.push({ type: "thinking", thinking: part.text });
      }
      if (item.encrypted_content) {
        parts.push({ type: "redacted_thinking", data: item.encrypted_content });
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
    usage: normalizeUsage(response.usage as Record<string, unknown> | undefined),
  };
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

  for (const block of response.content) {
    if (block.type === "text") {
      parts.push(text(block.text));
      continue;
    }

    if (block.type === "thinking") {
      parts.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      continue;
    }

    if (block.type === "redacted_thinking") {
      parts.push({ type: "redacted_thinking", data: block.data });
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
    usage: normalizeUsage(response.usage as Record<string, unknown> | undefined),
  };
}

export function denormalizeToOpenAIChatResponse(response: NormalizedResponse): OpenAIChatResponse {
  const visibleParts = response.message.parts.filter((part) => part.type === "text" || part.type === "refusal");
  const thinking = response.message.parts.filter((part) => part.type === "thinking").map((part) => part.thinking).join("\n");
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
          tool_calls: response.message.toolCalls?.map((toolCall) =>
            toolCall.kind === "function"
              ? { id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.payload } }
              : { id: toolCall.id, type: "custom", custom: { name: toolCall.name, input: toolCall.payload } },
          ),
        },
      },
    ],
    usage: denormalizeUsageToOpenAIChat(response.usage) as OpenAIChatResponse["usage"],
  };
}

export function denormalizeToOpenAIResponsesResponse(response: NormalizedResponse): OpenAIResponsesResponse {
  const reasoningParts = response.message.parts.filter((part) => part.type === "thinking");
  const visibleParts = response.message.parts.filter((part) => part.type === "text" || part.type === "refusal");
  return {
    id: response.id,
    object: "response",
    created_at: response.createdAt,
    model: response.model,
    output_text: collapseText(visibleParts as any),
    error: null,
    incomplete_details: null,
    instructions: null,
    // metadata: null,
    output: [
      ...reasoningParts.map((part, index) => ({
        id: `reasoning_${index}`,
        type: "reasoning",
        summary: [{ type: "summary_text", text: part.thinking }],
        content: [{ type: "reasoning_text", text: part.thinking }],
        status: "completed",
      })),
      ...(visibleParts.length > 0
        ? [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: visibleParts.map((part) =>
                part.type === "text"
                  ? { type: "output_text", text: part.text, annotations: [] }
                  : { type: "refusal", refusal: part.text },
              ),
            },
          ]
        : []),
      ...(response.message.toolCalls?.map((toolCall) =>
        toolCall.kind === "custom" || (toolCall.kind === "function" && isResponsesCustomToolName(toolCall.name))
          ? { id: toolCall.id, type: "custom_tool_call", call_id: toolCall.id, name: toolCall.name, input: toolCall.kind === "custom" ? toolCall.payload : unwrapResponsesCustomToolInput(toolCall.payload), status: "completed" }
          : { id: toolCall.id, type: "function_call", call_id: toolCall.id, name: toolCall.name, arguments: toolCall.payload, status: "completed" },
      ) ?? []),
    ] as OpenAIResponsesResponse["output"],
    parallel_tool_calls: (response.message.toolCalls?.length ?? 0) > 1,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    status: "completed",
    text: { format: { type: "text" } },
    usage: denormalizeUsageToOpenAIResponses(response.usage) as OpenAIResponsesResponse["usage"],
  };
}

export function denormalizeToAnthropicResponse(response: NormalizedResponse): AnthropicMessagesResponse {
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    container: null,
    stop_reason: normalizeAnthropicStopReason(response.finishReason),
    stop_sequence: null,
    content: [
      ...response.message.parts.flatMap((part) => {
        if (part.type === "text" || part.type === "refusal") return [{ type: "text" as const, text: part.text, citations: null }];
        if (part.type === "thinking") return [{ type: "thinking" as const, thinking: part.thinking, signature: part.signature ?? "" }];
        if (part.type === "redacted_thinking") return [];
        return [{ type: "text" as const, text: collapseText([part]), citations: null }];
      }),
      ...(response.message.toolCalls?.map((toolCall) => {
        if (toolCall.kind !== "function") fail("Anthropic response conversion only supports function-style tool calls");
        return {
          type: "tool_use" as const,
          id: toolCall.id,
          caller: { type: "direct" as const },
          name: toolCall.name,
          input: parseJson(toolCall.payload, `Anthropic tool call "${toolCall.name}"`),
        };
      }) ?? []),
    ],
    usage: (denormalizeUsageToAnthropic(response.usage) as AnthropicMessagesResponse["usage"]) ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
    },
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
