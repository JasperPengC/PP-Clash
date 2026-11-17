/** 沿当前选项追踪实际生效分组；保留原始 now，用于正确选择节点。 */
export function resolveEffectiveGroup<T extends { name: string; now?: string | null }>(groups: readonly T[], name: string): T | undefined {
  const byName = new Map(groups.map(group => [group.name, group]));
  let group = byName.get(name);
  const seen = new Set<string>();
  while (group && !seen.has(group.name)) {
    seen.add(group.name);
    const next = group.now ? byName.get(group.now) : undefined;
    if (!next) break;
    group = next;
  }
  return group;
}
