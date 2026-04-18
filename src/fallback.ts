export function sortFallbackGroupMembers(
  members: string[],
  getFailureCount: (name: string) => number,
): string[] {
  return [...members].sort((left, right) => {
    const leftScore = getFailureCount(left) - 2;
    const rightScore = getFailureCount(right) - 2;
    return rightScore - leftScore;
  });
}
