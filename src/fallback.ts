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
