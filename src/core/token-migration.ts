import { isMap, isScalar, isSeq, parseDocument, YAMLSeq } from "yaml";

/**
 * Moves the `auth_token` of models and fallback groups (the format before top-level `tokens`) into `tokens`:
 * one entry per distinct token value, mapping each name it opened to itself. A group's object form
 * (`{ models, auth_token }`) goes back to the plain list. Comments outside the rewritten nodes are kept.
 * Returns the rewritten YAML, or undefined when there is nothing to migrate.
 */
export function migrateLegacyAuthTokens(rawText: string): string | undefined {
  const document = parseDocument(rawText);
  if (document.errors.length > 0) return undefined;
  const found = new Map<string, string[]>();
  let changed = false;
  const collect = (value: unknown, name: unknown) => {
    const token = isScalar(value) ? value.value : value;
    if (token === undefined || token === null || typeof name !== "string" || !name) return;
    const text = String(token).trim();
    if (!text) return;
    const names = found.get(text) ?? [];
    if (!names.includes(name)) names.push(name);
    found.set(text, names);
  };

  const models = document.get("models");
  if (isSeq(models)) {
    for (const model of models.items) {
      if (!isMap(model) || !model.has("auth_token")) continue;
      collect(model.get("auth_token"), model.get("name"));
      model.delete("auth_token");
      changed = true;
    }
  }

  const fallback = document.get("fallback");
  if (isMap(fallback)) {
    for (const pair of fallback.items) {
      if (!isMap(pair.value)) continue;
      const groupName = isScalar(pair.key) ? pair.key.value : pair.key;
      collect(pair.value.get("auth_token"), groupName);
      const members = pair.value.get("models");
      pair.value = isSeq(members) ? members : new YAMLSeq();
      changed = true;
    }
  }

  if (!changed) return undefined;
  if (found.size > 0) {
    let tokens = document.get("tokens");
    if (!isSeq(tokens)) {
      if (tokens !== undefined && tokens !== null) throw new Error("Cannot migrate 'auth_token' because 'tokens' is not a list");
      tokens = new YAMLSeq();
      document.set("tokens", tokens);
    }
    const list = tokens as YAMLSeq;
    for (const [value, names] of found) {
      const existing = list.items.find((item) => isMap(item) && String(item.get("value") ?? "").trim() === value);
      if (!isMap(existing)) {
        list.add(document.createNode({ value, available_models: names.map((name) => ({ [name]: name })) }));
        continue;
      }
      let mappings = existing.get("available_models");
      if (!isSeq(mappings)) {
        mappings = new YAMLSeq();
        existing.set("available_models", mappings);
      }
      const seq = mappings as YAMLSeq;
      const aliases = new Set(seq.items.flatMap((item) => (isMap(item) ? item.items.map((pair) => String(isScalar(pair.key) ? pair.key.value : pair.key)) : isScalar(item) ? [String(item.value)] : [])));
      for (const name of names) if (!aliases.has(name)) seq.add(document.createNode({ [name]: name }));
    }
  }
  return document.toString({ lineWidth: 0 });
}
