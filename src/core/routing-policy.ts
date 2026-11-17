import yaml from 'js-yaml';

interface Group { name: string; type: string; proxies?: string[] }
export interface RoutingPolicy { primary: string; managed: string[]; roots?: string[] }

export const isStableEgressName = (name: string) => /git\s*hub|代码|开发|程序|固定出口/i.test(name);

/** 在改变分组类型之前确定主路由，避免类型/节点数量排序把地区组当成主出口。 */
export function routingPolicy(groups: Group[], rules: string[]): RoutingPolicy {
  const names = new Set(groups.map(g => g.name));
  const match = rules.map(r => r.split(',').map(v => v.trim())).find(r => ['MATCH', 'FINAL'].includes(r[0]) && names.has(r[1]));
  const referenced = new Set(groups.flatMap(g => g.proxies ?? []));
  const primary = match?.[1] || groups.find(g => g.type === 'select' && !referenced.has(g.name))?.name ||
    groups.find(g => g.type === 'select')?.name || groups[0]?.name || '';
  const managed = new Set<string>();
  const visit = (name: string) => {
    if (managed.has(name)) return;
    const group = groups.find(g => g.name === name);
    if (!group || !['select', 'url-test', 'fallback'].includes(group.type)) return;
    managed.add(name);
    for (const child of group.proxies ?? []) visit(child);
  };
  visit(primary);
  const targets = rules.map(r => r.split(',').map(v => v.trim()).reverse().find(v => names.has(v))).filter((v): v is string => !!v);
  return { primary, managed: [...managed], roots: [...new Set([primary, ...targets])].filter(name => managed.has(name)) };
}

let lastRaw = '';
let cached: RoutingPolicy = { primary: '', managed: [] };
export function subscriptionRoutingPolicy(raw: string): RoutingPolicy {
  if (raw === lastRaw) return cached;
  lastRaw = raw;
  try {
    const doc = yaml.load(raw) as Record<string, unknown>;
    cached = routingPolicy(Array.isArray(doc?.['proxy-groups']) ? doc['proxy-groups'] as Group[] : [],
      Array.isArray(doc?.rules) ? doc.rules.map(String) : []);
  } catch { cached = { primary: '', managed: [] }; }
  return cached;
}
