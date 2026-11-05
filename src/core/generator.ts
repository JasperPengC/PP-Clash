import yaml from 'js-yaml';
import { auditSubscription, type Finding } from './audit';
import { runJsOverride } from './js-sandbox';
import { stripInfoNodes } from './subscription';
import {
  buildDns,
  buildGuardRules,
  buildSniffer,
  buildTopLevel,
  buildTun,
  type SecurityPolicy,
} from './security';

/** GitHub 登录/API/资源域名。登录态对出口 IP 很敏感，切节点时保持固定出口。 */
export const STABLE_EGRESS_GROUP = 'GitHub 固定出口';
export const STABLE_EGRESS_DOMAINS = [
  'github.com',
  'githubusercontent.com',
  'githubassets.com',
  'githubapp.com',
] as const;

export interface RuntimeOptions {
  mixedPort: number;
  controllerPort: number;
  controllerSecret: string;
  geoDataMode?: 'db' | 'dat';
  geoAutoUpdate?: boolean;
  geoUpdateInterval?: number;
  geoUrls?: {
    geoip?: string;
    geosite?: string;
    mmdb?: string;
    asn?: string;
    country?: string;
  };
  tunEnabled: boolean;
  mode: 'rule' | 'global' | 'direct';
  /** 允许局域网连接；默认关闭。 */
  allowLan?: boolean;
  /** 内核 DNS 监听端口，默认 1053。 */
  dnsPort?: number;
  /** 额外监听端口；0 表示关闭。 */
  socksPort?: number;
  httpPort?: number;
  redirPort?: number;
  bindAddress?: string;
  authUser?: string;
  authPass?: string;
  /** DNS 服务器模式与自定义地址。 */
  dnsNameserver?: 'auto' | 'cloudflare' | 'google' | 'quad9' | 'custom';
  dnsCustom?: string;
  /** 嗅探开关。 */
  snifferEnabled?: boolean;
  snifferOverrideDestination?: boolean;
  /** 自定义规则：插在内置防护规则之后、订阅规则之前。 */
  customRules?: import('../store/app').CustomRule[];
  /** 当前实际使用的节点名；供 MATCH/当前节点与覆写占位符使用。 */
  currentNode?: string;
  /** GitHub 等登录敏感站点固定出口，避免节点切换导致 IP 频繁变化。 */
  stableEgress?: {
    enabled: boolean;
    node: string;
    domains: readonly string[];
  };
}

export interface RuleEditState {
  /** 完整顺序；未出现的下标按原始顺序补在后面。 */
  order: number[];
  edits: Record<number, { enabled?: boolean; target?: string }>;
}

/** 应用订阅规则编辑：排序、启停、目标覆盖。防护规则和自定义规则不参与。 */
function applyRuleEdits(rules: string[], edits?: RuleEditState): string[] {
  if (!edits) return rules;
  const seen = new Set<number>();
  const order: number[] = [];
  for (const i of edits.order) {
    if (Number.isInteger(i) && i >= 0 && i < rules.length && !seen.has(i)) {
      seen.add(i);
      order.push(i);
    }
  }
  for (let i = 0; i < rules.length; i += 1) {
    if (!seen.has(i)) order.push(i);
  }

  const out: string[] = [];
  for (const index of order) {
    const edit = edits.edits[index];
    if (edit?.enabled === false) continue;
    let rule = rules[index];
    const target = edit?.target?.trim();
    if (target) {
      const parts = rule.split(',').map((p) => p.trim());
      if (parts[0] === 'MATCH') {
        rule = `MATCH,${target}`;
      } else if (parts.length >= 3) {
        parts[2] = target;
        rule = parts.join(',');
      }
    }
    out.push(rule);
  }
  return out;
}

export interface OverrideInput {
  mode: 'yaml' | 'js';
  text: string;
  /** 仅用于报错定位。 */
  name?: string;
}

export const DEFAULT_RUNTIME: RuntimeOptions = {
  mixedPort: 7890,
  controllerPort: 9090,
  controllerSecret: '',
  tunEnabled: false,
  mode: 'rule',
};

export interface ConfigStats {
  proxyCount: number;
  groupCount: number;
  ruleCount: number;
  guardRuleCount: number;
}

export interface GeneratedConfig {
  /** 最终交给内核的配置文本（JSON，YAML 超集）。 */
  config: string;
  stats: ConfigStats;
  audit: Finding[];
}

type Dict = Record<string, unknown>;

function deepMerge<T>(base: T, patch: unknown): T {
  if (Array.isArray(patch)) return patch as unknown as T;
  if (patch && typeof patch === 'object') {
    const out: Dict = {
      ...(base && typeof base === 'object' && !Array.isArray(base)
        ? (base as Dict)
        : {}),
    };
    for (const [key, value] of Object.entries(patch as Dict)) {
      out[key] = deepMerge(out[key], value);
    }
    return out as T;
  }
  return (patch === undefined ? base : patch) as T;
}

function asDict(v: unknown): Dict {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * 把「订阅内容」和「内置安全策略」合成最终交给内核的配置。
 *
 * 合并规则只有一条：**订阅说了算的部分只有节点和业务规则，其余全部由应用决定。**
 * 订阅自带的 dns / tun / sniffer / profile / ipv6 会被整体丢弃，
 * 因为它们是最常见的泄漏来源，而不是用户需要调的东西。
 */
export async function generateConfig(
  subscriptionYaml: string,
  policy: SecurityPolicy,
  runtime: RuntimeOptions = DEFAULT_RUNTIME,
  overrides?: OverrideInput[],
  ruleEdits?: RuleEditState
): Promise<GeneratedConfig> {
  const doc = asDict(yaml.load(subscriptionYaml));

  // 订阅里可能混着「剩余流量 / 套餐到期」这类信息节点，生成配置前剔掉
  const { proxies, groups } = stripInfoNodes(
    asArray(doc.proxies),
    asArray(doc['proxy-groups'])
  );
  const providers = asDict(doc['proxy-providers']);
  const subscriptionRules = applyRuleEdits(
    asArray(doc.rules).map(String),
    ruleEdits
  );

  const guardRules = buildGuardRules(policy);

  // 把 GitHub 域名固定到一个节点：主选择组怎么切都不影响 GitHub 的出口 IP。
  const stable = runtime.stableEgress;
  const proxyNames = new Set(
    proxies.map((p) => String(asDict(p).name ?? '')).filter(Boolean)
  );
  const stableNode =
    stable?.enabled && stable.node && proxyNames.has(stable.node)
      ? stable.node
      : '';
  const stableGroupName = STABLE_EGRESS_GROUP;
  const hasStableGroup = groups.some(
    (g) => String(asDict(g).name ?? '') === stableGroupName
  );
  if (stableNode && !hasStableGroup) {
    groups.push({
      name: stableGroupName,
      type: 'select',
      proxies: [stableNode],
    });
  }
  const stableRules = stableNode
    ? (stable?.domains ?? STABLE_EGRESS_DOMAINS).map(
        (domain) => `DOMAIN-SUFFIX,${domain},${stableGroupName}`
      )
    : [];

  let config: Dict = {
    // 安全策略负责的顶层字段
    ...buildTopLevel(policy),

    // 应用自己的运行时设置
    'mixed-port': runtime.mixedPort,
    // 没有认证凭据时不允许局域网暴露代理端口
    'allow-lan': Boolean(runtime.allowLan && runtime.authUser && runtime.authPass),
    'find-process-mode': 'always',
    'socks-port': runtime.socksPort ?? 0,
    'port': runtime.httpPort ?? 0,
    'redir-port': runtime.redirPort ?? 0,
    'bind-address': runtime.bindAddress || '127.0.0.1',
    mode: runtime.mode,
    'log-level': 'warning',
    'external-controller': `127.0.0.1:${runtime.controllerPort}`,
    ...(runtime.controllerSecret ? { secret: runtime.controllerSecret } : {}),
    'geodata-mode': runtime.geoDataMode === 'dat',
    'geo-auto-update': runtime.geoAutoUpdate ?? false,
    'geo-update-interval': runtime.geoUpdateInterval ?? 24,
    ...(runtime.geoUrls
      ? {
          'geox-url': {
            geoip: runtime.geoUrls.geoip,
            geosite: runtime.geoUrls.geosite,
            mmdb: runtime.geoUrls.mmdb,
            asn: runtime.geoUrls.asn,
          },
        }
      : {}),

    // 安全策略负责的子系统
    dns: buildDns(policy, runtime.dnsPort ?? 1053),
    tun: buildTun(policy, runtime.tunEnabled),
    sniffer: buildSniffer(),

    // 订阅负责的部分
    ...(proxies.length ? { proxies } : {}),
    ...(groups.length ? { 'proxy-groups': groups } : {}),
    ...(Object.keys(providers).length ? { 'proxy-providers': providers } : {}),

    // 登录敏感站点的固定出口优先，其次才是防护与订阅规则
    rules: [
      ...stableRules,
      ...guardRules,
      ...(runtime.customRules ?? [])
        .filter((r) => r.enabled)
        .map((r) => {
          const target =
            r.target === '__CURRENT__' ? runtime.currentNode || 'DIRECT' : r.target;
          return r.type === 'MATCH' ? `MATCH,${target}` : `${r.type},${r.payload},${target}`;
        }),
      ...subscriptionRules,
    ],
  };

  if (runtime.authUser && runtime.authPass) {
    config.authentication = [`${runtime.authUser}:${runtime.authPass}`];
  }

  // 自定义 DNS 服务器：放在安全策略的 nameserver 前面，保留其余策略字段
  if (runtime.dnsNameserver && runtime.dnsNameserver !== 'auto') {
    const presets: Record<string, string[]> = {
      cloudflare: ['https://1.1.1.1/dns-query', 'https://dns.cloudflare.com/dns-query'],
      google: ['https://dns.google/dns-query'],
      quad9: ['https://dns.quad9.net/dns-query'],
    };
    const custom =
      runtime.dnsNameserver === 'custom'
        ? [runtime.dnsCustom ?? ''].filter((v) => v.trim()).map((v) => v.trim())
        : presets[runtime.dnsNameserver] ?? [];
    if (custom.length > 0) {
      const dns = config.dns as Dict;
      const existing = Array.isArray(dns.nameserver) ? (dns.nameserver as unknown[]) : [];
      dns.nameserver = [...custom, ...existing];
    }
  }

  // 嗅探：从 HTTP/TLS 握手提取域名，减少纯 IP 连接匹配不到规则的概率
  if (runtime.snifferEnabled) {
    config.sniffer = {
      enable: true,
      'override-destination': Boolean(runtime.snifferOverrideDestination),
      sniff: {
        HTTP: { ports: [80, '8080-8880'] },
        TLS: { ports: [443, 8443] },
        QUIC: { ports: [443, 8443] },
      },
    };
  }

  // 进阶覆写：按顺序应用多份 YAML/JSON 深合并或 JS 脚本
  for (const override of overrides ?? []) {
    if (!override.text.trim()) continue;
    const text = override.text.replace(
      /\{\{CURRENT_NODE\}\}/g,
      runtime.currentNode || 'DIRECT'
    );
    if (override.mode === 'js') {
      try {
        config = await runJsOverride(config, text);
      } catch (e) {
        const name = override.name || '未命名';
        throw new Error(`JS 覆写「${name}」失败：${(e as Error).message}`);
      }
    } else {
      try {
        const patch = yaml.load(text);
        if (patch && typeof patch === 'object') {
          config = deepMerge(config, patch);
        }
      } catch (e) {
        console.warn('[PPClash] YAML 覆写解析失败，已忽略', e);
      }
    }
  }

  return {
    // mihomo 的配置解析器是 YAML 解析器，而 JSON 是 YAML 的子集，
    // 所以直接输出 JSON：序列化可靠，不用自己写 YAML emitter 处理各种转义。
    config: JSON.stringify(config, null, 2),
    stats: {
      proxyCount: proxies.length,
      groupCount: groups.length,
      ruleCount: subscriptionRules.length,
      guardRuleCount: guardRules.length,
    },
    audit: auditSubscription(subscriptionYaml),
  };
}

/** 解析订阅里的节点名，用于体检报告和 UI 预览。 */
export function listProxyNames(subscriptionYaml: string): string[] {
  try {
    const doc = asDict(yaml.load(subscriptionYaml));
    return asArray(doc.proxies)
      .map((p) => String(asDict(p).name ?? ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}
