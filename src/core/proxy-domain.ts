import yaml from 'js-yaml';
import type { ProxyGroup, ProxyNode } from '../domain/app';
import { isInfoNode } from './subscription';

export interface ProxyProvider {
  name: string;
  state: 'waiting' | 'loaded' | 'empty' | 'cached' | 'error';
  updatedAt?: string;
  error?: string;
  count: number;
}
export interface ProxyObject {
  name: string;
  type: string;
  providers: string[];
  dialerProxy?: string;
  dialerSource?: 'runtime' | 'configuration';
  missing?: boolean;
  configurationKnown?: boolean;
}
export interface DomainGroup extends ProxyGroup {
  synthetic: boolean;
  providers: ProxyProvider[];
  membershipUncertain: boolean;
}
export interface ProxyDomainInput {
  raw?: string;
  groups?: ProxyGroup[];
  profileId: string | null;
  revision: number | string;
  runtime: boolean;
  runtimeProxies?: unknown;
  providers?: unknown;
  providersError?: string;
}
export interface ProxyDomain {
  identity: string;
  runtime: boolean;
  groups: DomainGroup[];
  objects: Map<string, ProxyObject>;
}
export type RouteIssueCode = 'unconfirmed-config' | 'stale-selection' | 'unselected' | 'cycle' | 'missing' | 'depth-limit' | 'relay-unverified';
export interface ProxyRoute {
  kind: 'selected' | 'direct' | 'reject' | 'multiple' | 'relay' | 'unknown';
  selection: string[];
  forwarding: string[];
  terminal: string | null;
  candidates: string[];
  certainty: 'configuration' | 'unknown';
  issues: Array<{ code: RouteIssueCode; at: string; message: string }>;
}
const types: Record<string, string> = { select: 'Selector', 'url-test': 'URLTest', fallback: 'Fallback', 'load-balance': 'LoadBalance', relay: 'Relay' };
const labels: Record<string, string> = { Selector: '手动选择', URLTest: '自动测速', Fallback: '故障转移', LoadBalance: '负载均衡', Relay: '旧 Relay', Browse: '节点浏览' };
export const proxyGroupKind = (type: string) => labels[type] ?? type;
const dict = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const names = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === 'string' && !!item && !isInfoNode(item));
const nodeType = (type: unknown) => types[String(type ?? '')] ?? String(type ?? '');
const special = (name: string) => name === 'DIRECT' || name === 'REJECT' || name === 'REJECT-DROP' || name === 'PASS';
export function readProxyConfiguration(raw = ''): Record<string, any> {
  try { return dict(yaml.load(raw)); } catch { return {}; }
}

/** Metadata is deliberately session-only. Raw subscription fields are never proof of the applied config. */
export function buildProxyDomain(input: ProxyDomainInput): ProxyDomain {
  const config = readProxyConfiguration(input.raw);
  const configuredGroups = list(config['proxy-groups']).map(dict).filter(group => typeof group.name === 'string');
  const objects = new Map<string, ProxyObject>();
  for (const name of ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']) objects.set(name, {name, type: name, providers: []});
  const addObject = (entry: unknown, provider?: string, runtime = false, configurationKnown = false) => {
    const value = dict(entry);
    if (typeof value.name !== 'string' || isInfoNode(value.name)) return;
    const old = objects.get(value.name);
    const dialer = value['dialer-proxy'];
    objects.set(value.name, { ...old, name: value.name, type: nodeType(value.type) || old?.type || '',
      providers: [...new Set([...(old?.providers ?? []), ...(provider ? [provider] : [])])], missing: false,
      configurationKnown: configurationKnown || old?.configurationKnown || false,
      ...(typeof dialer === 'string' && dialer ? {dialerProxy: dialer, dialerSource: runtime ? 'runtime' : 'configuration'} : {}) });
  };
  list(config.proxies).forEach(proxy => addObject(proxy, undefined, false, true));
  const providerSnapshot = dict(dict(input.providers).providers);
  const providerConfig = dict(config['proxy-providers']);
  const providerNames = [...new Set([...Object.keys(providerConfig), ...Object.keys(providerSnapshot)])];
  const providerByName = new Map<string, ProxyProvider>();
  const providerMembers = new Map<string, string[]>();
  for (const name of providerNames) {
    const snapshot = dict(providerSnapshot[name]);
    const loaded = Array.isArray(snapshot.proxies);
    const members = list(snapshot.proxies).map(dict).filter(proxy => typeof proxy.name === 'string' && !isInfoNode(proxy.name));
    const error = input.providersError || (typeof snapshot.error === 'string' ? snapshot.error : undefined);
    members.forEach(proxy => addObject(proxy, name, true));
    providerMembers.set(name, members.map(proxy => proxy.name));
    providerByName.set(name, { name, count: members.length,
      state: error ? loaded ? 'cached' : 'error' : loaded ? members.length ? 'loaded' : 'empty' : 'waiting',
      ...(typeof snapshot.updatedAt === 'string' ? { updatedAt: snapshot.updatedAt } : {}), ...(error ? {error} : {}) });
  }
  for (const [name, value] of Object.entries(dict(input.runtimeProxies))) addObject({...dict(value), name}, undefined, true);
  for (const group of input.groups ?? []) {
    addObject(group);
    for (const node of group.nodes) if (node.type || objects.has(node.name)) addObject(node);
  }
  const configuredNames = new Set(configuredGroups.map(group => group.name));
  configuredGroups.forEach(group => addObject(group));
  const groupConfig = new Map(configuredGroups.map(group => [group.name, group]));
  const localNodes = names(list(config.proxies).map(proxy => dict(proxy).name));
  const hasRuntimeGroups = input.runtime && (input.runtimeProxies !== undefined || Boolean(input.groups?.length));
  const sourceGroups: ProxyGroup[] = hasRuntimeGroups ? input.groups ?? [] : configuredGroups.map(group => {
    const includeProviders = group['include-all'] || group['include-all-providers'];
    const sourceNames = [...new Set([...names(group.use), ...(includeProviders ? providerNames : [])])];
    const members = [...new Set([...names(group.proxies),
      ...(group['include-all'] || group['include-all-proxies'] ? localNodes : []),
      ...sourceNames.flatMap(name => providerMembers.get(name) ?? [])])];
    // mihomo uses its own regexp/filter semantics. Preview keeps candidates and marks that filtering is unconfirmed.
    return { name: group.name, type: nodeType(group.type), now: '', nodes: members.map(name => ({name,
      type: objects.get(name)?.type ?? '', delay: null})) };
  });
  const order = new Map(configuredGroups.map((group, index) => [group.name, index]));
  const groups = [...sourceGroups].sort((a,b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER))
    .map((group): DomainGroup => {
      const cfg = groupConfig.get(group.name) ?? {};
      const sourceNames = [...new Set([...names(cfg.use), ...(cfg['include-all'] || cfg['include-all-providers'] ? providerNames : [])])];
      const providers = sourceNames.map(name => providerByName.get(name) ?? {name, state:'waiting' as const, count:0});
      group.nodes.forEach(node => { if (!objects.has(node.name)) objects.set(node.name, {name:node.name,type:node.type,providers:[],missing:true}); });
      return {...group, nodes: group.nodes.filter(node => !isInfoNode(node.name)), synthetic: false, providers,
        membershipUncertain: !input.runtime && Boolean(cfg.filter || cfg['exclude-filter'] || cfg['exclude-type'])};
    });
  if (!groups.length) {
    const observedNames = input.runtime && input.runtimeProxies ? new Set(Object.keys(dict(input.runtimeProxies))) : null;
    const nodes: ProxyNode[] = [...objects.values()].filter(object => (!observedNames || observedNames.has(object.name)) && !special(object.name) && object.name !== 'GLOBAL'
      && !configuredNames.has(object.name) && !Array.isArray(dict(dict(input.runtimeProxies)[object.name]).all))
      .map(object => ({name:object.name,type:object.type,delay:null}));
    if (nodes.length || providerNames.length) groups.push({name:'全部节点',type:'Browse',now:'',nodes,synthetic:true,
      providers:[...providerByName.values()],membershipUncertain:false});
  }
  return { identity: JSON.stringify([input.profileId, input.revision, input.raw ?? '']), runtime:input.runtime, groups, objects };
}

/** Resolve strategy choices separately from the inferred connection order. All walks have a shared budget. */
export function resolveProxyRoute(domain: ProxyDomain, name: string): ProxyRoute {
  const result: ProxyRoute = {kind:'unknown',selection:[],forwarding:[],terminal:null,candidates:[],certainty:'unknown',issues:[]};
  const byName = new Map(domain.groups.filter(group => !group.synthetic).map(group => [group.name, group]));
  let budget = 128;
  const issue = (code:RouteIssueCode, at:string, message:string) => { if (!result.issues.some(item=>item.code===code&&item.at===at)) result.issues.push({code,at,message}); };
  const guard = (at:string, seen:Set<string>, depth:number) => {
    if (seen.has(at)) { issue('cycle',at,`「${at}」存在循环引用`); return false; }
    if (depth >= 16 || --budget < 0) { issue('depth-limit',at,`「${at}」超过展开上限`); return false; }
    return true;
  };
  type Selection = {kind: ProxyRoute['kind']; terminal: string | null; path: string[]; candidates: string[]; relayMembers?: string[]};
  const select = (at:string, seen:Set<string>, depth:number): Selection => {
    const unresolved: Selection = {kind:'unknown',terminal:null,path:[at],candidates:[]};
    if (!guard(at,seen,depth)) return unresolved;
    const group=byName.get(at);
    if (!group) {
      const object=domain.objects.get(at);
      if (!object || object.missing || ['Selector','URLTest','Fallback','LoadBalance','Relay','Group'].includes(object.type)) {
        issue('missing',at,`缺少引用「${at}」`);return unresolved;
      }
      return {...unresolved,kind:'selected',terminal:at};
    }
    if (group.type==='LoadBalance') return {...unresolved,kind:'multiple',candidates:group.nodes.map(node=>node.name)};
    if (group.type==='Relay') {
      issue('relay-unverified',at,'旧 Relay 按原配置顺序展示；当前内核能力与实际转发未验证');
      if(group.nodes.length>16) issue('depth-limit',at,'Relay 成员超过展开上限');
      return {...unresolved,kind:'relay',relayMembers:group.nodes.slice(0,16).map(node=>node.name)};
    }
    if (!group.now) {issue('unselected',at,`「${at}」尚无已确认选择`);return unresolved;}
    if (!group.nodes.some(node=>node.name===group.now)) {issue('stale-selection',at,`「${at}」的当前项「${group.now}」已不在成员中`);return unresolved;}
    const selected=select(group.now,new Set([...seen,at]),depth+1);
    return {...selected,path:[at,...selected.path]};
  };
  const selected=select(name,new Set(),0);
  result.selection=selected.path;
  result.kind=selected.kind;
  result.candidates=selected.candidates;
  if(selected.kind==='relay') result.forwarding=['本机',...(selected.relayMembers??[])];
  const terminal=selected.terminal;
  let upstreamStrategyUnresolved=false;
  const forward = (at:string, seen:Set<string>,depth:number): string[] | null => {
    if(!guard(at,seen,depth)) return null;
    if(at==='PASS') { issue('unconfirmed-config',at,'PASS 继续交给后续规则，无法确认唯一出口'); return null; }
    const object=domain.objects.get(at);
    if(!object || object.missing) {issue('missing',at,`缺少引用「${at}」`);return null;}
    if(!object.dialerProxy) return [at];
    const nextSeen=new Set([...seen,at]);
    const upstream=select(object.dialerProxy,nextSeen,depth+1);
    if(!upstream.terminal) {
      if(upstream.kind==='relay'||upstream.kind==='multiple') {
        upstreamStrategyUnresolved=true;
        issue('unconfirmed-config',object.dialerProxy,`前置策略「${object.dialerProxy}」${upstream.kind==='relay'?'为旧 Relay，能力未验证':'按连接分配多个出口'}；在此前置停止展开，落地「${at}」的完整转发路径未确认`);
      }
      return null;
    }
    if(upstream.terminal==='DIRECT') return [at];
    const path=forward(upstream.terminal,nextSeen,depth+1);
    return path ? path.some(name=>name==='REJECT'||name==='REJECT-DROP') ? path : [...path,at] : null;
  };
  if(terminal) {
    const path=forward(terminal,new Set(),0);
    if(!path) { result.kind=upstreamStrategyUnresolved?'selected':'unknown';result.terminal=upstreamStrategyUnresolved?terminal:null; }
    if(path) {
      const blocked=path.find(name=>name==='REJECT'||name==='REJECT-DROP');
      result.kind=terminal==='DIRECT'?'direct':blocked?'reject':'selected';
      result.terminal=blocked??terminal;
      const hasPathMetadata=path.every(name=>special(name)||domain.objects.get(name)?.configurationKnown||domain.objects.get(name)?.dialerSource==='runtime');
      if(hasPathMetadata) result.forwarding=['本机',...path];
      else issue('unconfirmed-config',name,'当前选择已观测；转发路径缺少配置元数据，实际链路尚未确认');
    }
  }
  if (result.forwarding.length && result.kind!=='direct'&&result.kind!=='reject') {
    result.certainty='configuration';
    issue('unconfirmed-config',name,'转发顺序为配置推断；覆写与实际生效配置尚未确认，整条链路未独立测量');
  }
  return result;
}
