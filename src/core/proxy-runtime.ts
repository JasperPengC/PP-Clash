import type { ProxyGroup, ProxyNode } from '../domain/app';
import { isInfoNode } from './subscription';
import { DEFAULT_LATENCY_URL, groupLatencyTarget, parseTargetLatencies } from './latency';
import { readProxyConfiguration } from './proxy-domain';

const GROUP_PRIORITY: Record<string, number> = {
  Selector: 0,
  URLTest: 1,
  Fallback: 2,
  LoadBalance: 3,
  Relay: 4,
};

/** 固定使用必须落到具体节点；选择子分组仍可能由下层策略切换出口。 */
export function isGroupNode(node: ProxyNode, groups: ProxyGroup[]): boolean {
  return node.name === 'GLOBAL' || Object.hasOwn(GROUP_PRIORITY, node.type) || groups.some(g => g.name === node.name);
}

export function parseRuntimeGroups(raw: any, profileRaw: string, publishGlobal?: (group: ProxyGroup | undefined) => void): ProxyGroup[] {
  const map = raw?.proxies ?? {};
  const out: ProxyGroup[] = [];
  const global = map.GLOBAL;
  if (publishGlobal) publishGlobal(global ? { name: 'GLOBAL', type: global.type, now: global.now ?? '',
    nodes: (global.all ?? []).map((name: string) => {
      const delaysByTarget = parseTargetLatencies(map[name]);
      return { name, type: map[name]?.type ?? '', delay: delaysByTarget[DEFAULT_LATENCY_URL] ?? null, delaysByTarget };
    }) } : undefined);

  for (const [name, info] of Object.entries<any>(map)) {
    // GLOBAL 是 mihomo 的全局兜底组，不是订阅分组：
    // 放进来会把「DIRECT / REJECT」当成当前节点顶到最前，概览和节点页都会显示错。
    if (name === 'GLOBAL') continue;
    if (!Object.hasOwn(GROUP_PRIORITY, String(info?.type ?? '')) && !Array.isArray(info?.all)) continue;
    const nodes: ProxyNode[] = (info.all ?? [])
      // 机场喜欢把「剩余流量：1.91 TB」这类信息塞成节点，节点列表里要滤掉
      .filter((n: string) => !isInfoNode(n))
      .map((n: string) => {
        const d = map[n];
        const delaysByTarget = parseTargetLatencies(d);
        const delay = delaysByTarget[groupLatencyTarget(name)] ?? null;
        return { name: n, type: d?.type ?? '', delay, delaysByTarget };
      });
    out.push({ name, type: info.type, now: info.now ?? '', nodes });
  }

  // 展示顺序来自订阅；内核新增的策略保留其返回顺序。主路由由 routing.primary 单独表达。
  const config = readProxyConfiguration(profileRaw);
  const order = new Map<string, number>((Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [])
    .map((group: { name?: string }, index: number) => [group.name ?? '', index]));
  out.sort((a, b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER));
  return out;
}
