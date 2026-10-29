import { Script } from "node:vm";

// The rule runs on every request before it is forwarded, so it gets a much tighter budget than the
// per-model body/response expressions.
const RULE_TIMEOUT_MS = 100;
const RULE_FILENAME = "record.skip_when";

let cached: { expression: string; script: Script } | undefined;

/** Compiles a `record.skip_when` expression; throws on a syntax error so a bad config is rejected on load. */
export function compileRecordRule(expression: string): Script {
  if (cached?.expression !== expression) {
    cached = { expression, script: new Script(`(${expression})`, { filename: RULE_FILENAME }) };
  }
  return cached.script;
}

// Header names arrive lowercased from Headers; the proxy lets a rule write headers.Authorization as well.
function caseInsensitiveHeaders(headers: Headers): Readonly<Record<string, string>> {
  const target = Object.freeze(Object.fromEntries(headers.entries()));
  return new Proxy(target, {
    get: (object, name) => (typeof name === "string" ? object[name.toLowerCase()] : Reflect.get(object, name)),
    has: (object, name) => (typeof name === "string" ? name.toLowerCase() in object : Reflect.has(object, name)),
  });
}

function errorMessage(error: unknown): string {
  // Errors thrown inside the vm context come from another realm and fail `instanceof Error`.
  return error && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error);
}

/**
 * Evaluates `record.skip_when` against the incoming client request. `headers` keeps the real
 * authorization values (case-insensitive names) so rules can match on a key; `body` is a frozen shallow copy so
 * an accidental assignment cannot change the request being routed. Any failure records the request.
 */
export function shouldSkipRecord(expression: string | undefined, input: { path: string; headers: Headers; body: unknown }): boolean {
  if (!expression) return false;
  const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? Object.freeze({ ...input.body }) : input.body;
  const model = (body as { model?: unknown } | undefined)?.model;
  try {
    const result = compileRecordRule(expression).runInNewContext({
      body,
      headers: caseInsensitiveHeaders(input.headers),
      model: typeof model === "string" ? model : undefined,
      path: input.path,
      console,
      Date,
      JSON,
      Math,
    }, { timeout: RULE_TIMEOUT_MS });
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("expression must return synchronously");
    }
    return !!result;
  } catch (error) {
    console.error(`[RECORD RULE] ${RULE_FILENAME} failed, recording the request: ${errorMessage(error)}`);
    return false;
  }
}
