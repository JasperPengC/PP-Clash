import type { ProxyGroup } from '../domain/app';

export function resolveActiveNode(groups: ProxyGroup[], name: string): string {
  let cur = name;
  const seen = new Set<string>();
  for (let i = 0; i < 8 && cur; i++) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const g = groups.find((x) => x.name === cur);
    if (!g) return cur;
    if (!g.now) return cur;
    cur = g.now;
  }
  return cur;
}
