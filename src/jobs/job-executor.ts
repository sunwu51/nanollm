import type { ModelConfig } from "../core/config.js";
import { buildModelTestRequest } from "../proxy/model-test.js";
import { createUsageCollector, SSEParser } from "../converters/streams.js";
import { type Job, type JobOutput, type JobResult } from "./jobs.js";

export interface ExecutionOutput { output: JobOutput; metrics: JobResult["metrics"] }
export class JobExecutionError extends Error {
  constructor(message: string, readonly partial: ExecutionOutput, options?: ErrorOptions) { super(message, options); }
}
export interface JobExecutor {
  type: string;
  /** `requestId` is stored on the attempt before the call so even timed-out attempts link to their request record. */
  execute(job: Job, model: ModelConfig, signal: AbortSignal, context?: { requestId: string }): Promise<ExecutionOutput>;
}
/**
 * Sends a client-format request for `model` and returns the client-format response (the gateway's own /v1 routes in production).
 * `signal` aborts the request, which also aborts the gateway's upstream call before the first byte arrives.
 */
export type JobRequestSender = (model: ModelConfig, request: { path: string; body: Record<string, unknown> }, signal: AbortSignal) => Promise<Response>;
export function outputMediaType(text: string): string {
  let content = text.trim().replace(/^\x60{3}(?:html|svg|xml|json)?[^\n]*\n([\s\S]*?)\x60{3}\s*$/i, "$1").trim();
  content = content.replace(/^<\?xml[\s\S]*?\?>\s*/i, "");
  if (/^<svg\b/i.test(content)) return "image/svg+xml";
  if (/^(?:<!doctype\s+html|<(?:html|head|body|div|main|style|section|canvas)\b)/i.test(content)) return "text/html";
  try { JSON.parse(content); return "application/json"; } catch { return "text/plain"; }
}

async function errorMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  let message: unknown;
  try { const body = JSON.parse(raw); message = body?.error?.message ?? body?.error; } catch { message = raw.slice(0, 500); }
  return `HTTP ${response.status}` + (typeof message === "string" && message ? ": " + message : "");
}

export const createModelRequestExecutor = (send: JobRequestSender): JobExecutor => ({
  type: "model_request",
  async execute(job, model, signal) {
    const started = Date.now();
    const response = await send(model, buildModelTestRequest(model.provider, model.name, job.request.message), signal);
    if (signal.aborted) { await response.body?.cancel(signal.reason).catch(() => {}); signal.throwIfAborted(); }
    if (!response.ok || !response.body) throw new Error(await errorMessage(response));
    const parser = new SSEParser(true), collector = createUsageCollector(model.provider), decoder = new TextDecoder();
    const reader = response.body.getReader();
    // Cancelling the client stream is what stops the gateway's upstream call.
    const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
    let text = "", textBytes = 0, wireBytes = 0, completed = false, truncated = false, ttfbMs: number | undefined;
    let streamError: string | undefined;
    const append = (part: string) => {
      const bytes = Buffer.from(part);
      if (textBytes + bytes.length > job.execution.max_output_bytes) {
        text += new TextDecoder().decode(bytes.subarray(0, Math.max(0, job.execution.max_output_bytes - textBytes))).replace(/\uFFFD$/, "");
        truncated = true; throw new Error("输出超过任务设置的大小限制");
      }
      text += part; textBytes += bytes.length;
    };
    const consume = (events: ReturnType<SSEParser["push"]>) => {
      for (const event of events) {
        if (event.data === "[DONE]") { completed = true; continue; }
        let value: any; try { value = JSON.parse(event.data); } catch { continue; }
        if (value.error || ["error", "response.failed"].includes(value.type)) streamError = "上游返回错误响应";
        if (value.type === "response.incomplete" || value.response?.status === "incomplete") { truncated = true; streamError = "上游响应未完成"; }
        if (model.provider === "openai-chat") {
          if (typeof value.choices?.[0]?.delta?.content === "string") append(value.choices[0].delta.content);
        } else if (model.provider === "openai-responses") {
          if (value.type === "response.output_text.delta" && typeof value.delta === "string") append(value.delta);
          if (value.type === "response.completed" && !text) {
            for (const item of value.response?.output ?? []) for (const part of item.content ?? []) if (part.type === "output_text" && typeof part.text === "string") append(part.text);
          }
        } else if (model.provider === "anthropic") {
          if (value.type === "content_block_start" && value.content_block?.type === "text" && value.content_block.text) append(value.content_block.text);
          if (value.type === "content_block_delta" && value.delta?.type === "text_delta") append(value.delta.text);
        }
        const reason = value.choices?.[0]?.finish_reason ?? value.delta?.stop_reason;
        if (["length", "max_tokens", "content_filter"].includes(reason)) { truncated = true; streamError = "输出被截断或过滤"; }
        if (reason || value.type === "response.completed" || value.type === "message_stop") completed = true;
      }
    };
    const partial = (): ExecutionOutput => ({ output: { text, media_type: outputMediaType(text), truncated }, metrics: { ttfb_ms: ttfbMs, usage: collector.getLatestUsage() } });
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
        ttfbMs ??= Date.now() - started; wireBytes += chunk.value.byteLength;
        if (wireBytes > Math.max(1024 * 1024, job.execution.max_output_bytes * 16)) { truncated = true; throw new Error("上游响应流超过大小限制"); }
        const decoded = decoder.decode(chunk.value, { stream: true }); collector.push(decoded); consume(parser.push(decoded));
      }
      const tail = decoder.decode(); collector.push(tail); consume([...parser.push(tail), ...parser.flush()]); collector.finish();
      signal.throwIfAborted();
      if (streamError) throw new Error(streamError);
      if (!completed) throw new Error("上游响应流未正常结束");
      if (!text.trim()) throw new Error("模型未返回文本内容");
      return partial();
    } catch (error) {
      throw new JobExecutionError(error instanceof Error ? error.message : String(error), partial(), { cause: error });
    } finally {
      signal.removeEventListener("abort", onAbort);
      await reader.cancel().catch(() => {}); reader.releaseLock();
    }
  },
});
