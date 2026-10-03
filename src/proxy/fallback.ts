export const FALLBACK_FAILURE_WINDOW_MS = 5 * 60 * 1000;

export class FallbackFailureTracker {
  private readonly failures = new Map<string, number[]>();

  private prune(name: string, now = Date.now()): number[] {
    const recent = (this.failures.get(name) ?? []).filter((timestamp) => now - timestamp <= FALLBACK_FAILURE_WINDOW_MS);
    this.failures.set(name, recent);
    return recent;
  }

  recordFailure(name: string, timestamp = Date.now()) {
    const failures = this.prune(name, timestamp);
    failures.push(timestamp);
    this.failures.set(name, failures);
  }

  getFailureCount(name: string, now = Date.now()): number {
    return this.prune(name, now).length;
  }
}

export function sortFallbackGroupMembers(
  members: string[],
  getFailureCount: (name: string) => number,
): string[] {
  return [...members].sort((left, right) => {
    const leftScore = Math.max(0, getFailureCount(left) - 1);
    const rightScore = Math.max(0, getFailureCount(right) - 1);
    return leftScore - rightScore;
  });
}
