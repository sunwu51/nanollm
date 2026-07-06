// In-memory cache for Responses API output items.
// Resolves `item_reference` in subsequent requests by inlining the actual item.

const MAX_ITEMS = 500;
const TTL_MS = 60 * 60 * 1000;

type CacheEntry = {
  item: unknown;
  cachedAt: number;
};

const cache = new Map<string, CacheEntry>();

function pruneExpired(now = Date.now()) {
  for (const [key, entry] of cache) {
    if (now - entry.cachedAt > TTL_MS) {
      cache.delete(key);
    }
  }
}

function pruneOverflow() {
  if (cache.size <= MAX_ITEMS) return;
  const toDelete = cache.size - MAX_ITEMS;
  const iter = cache.keys();
  for (let i = 0; i < toDelete; i++) {
    const key = iter.next().value;
    if (key) cache.delete(key);
  }
}

export function cacheResponseItems(output: unknown) {
  if (!Array.isArray(output)) return;
  const now = Date.now();
  pruneExpired(now);
  for (const item of output) {
    if (item && typeof item === "object" && "id" in item && item.id) {
      cache.set(item.id as string, { item, cachedAt: now });
    }
  }
  pruneOverflow();
}

export function resolveItemReferences(input: unknown[]): unknown[] {
  const now = Date.now();
  pruneExpired(now);
  return input.flatMap((item) => {
    if (item && typeof item === "object" && "type" in item && (item as any).type === "item_reference") {
      const id = (item as any).id;
      const cached = id ? cache.get(id) : undefined;
      if (!cached) return [];
      if (now - cached.cachedAt > TTL_MS) {
        cache.delete(id);
        return [];
      }
      return [cached.item];
    }
    return [item];
  });
}
