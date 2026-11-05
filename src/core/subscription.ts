import yaml from 'js-yaml';

/**
 * 订阅响应头解析 + 订阅原文预览。
 *
 * 机场通常在响应头里下发：
 *   profile-title: 订阅名（可能是 base64:xxx）
 *   content-disposition: attachment;filename*=UTF-8''Example%20Air
 *   subscription-userinfo: upload=…; download=…; total=…; expire=…
 * 这些是「订阅叫什么、还剩多少流量」的唯一可靠来源，比从节点名里猜靠谱。
 */

export interface TrafficInfo {
  upload: number;
  download: number;
  total: number;
  /** 秒级时间戳；0 表示不限期。 */
  expire: number;
}

export interface SubscriptionMeta {
  /** 响应头里带回来的真实订阅名；没有则为 null。 */
  name: string | null;
  traffic: TrafficInfo | null;
  /** 建议的自动更新间隔（小时）。 */
  updateIntervalHours: number | null;
}

export interface SubscriptionHeaders {
  profileTitle?: string | null;
  contentDisposition?: string | null;
  subscriptionUserinfo?: string | null;
  profileUpdateInterval?: string | null;
}

/** 机场节点列表里常混入「剩余流量：1.91 TB」这类信息节点，不是真节点。 */
const INFO_NODE_PATTERNS = [
  '剩余流量',
  '距离下次重置',
  '套餐到期',
  '到期时间',
  '过期时间',
  '官方网站',
  '官网',
  '客服',
  '节点异常',
  '请更新订阅',
  '订阅已过期',
];

export function isInfoNode(name: string): boolean {
  return INFO_NODE_PATTERNS.some((p) => name.includes(p));
}

/** base64:xxx → 文本。解不出来就原样返回，绝不因为一个标题让导入失败。 */
function decodeMaybeBase64(value: string): string {
  const trimmed = value.trim();
  const m = /^base64:(.*)$/i.exec(trimmed);
  if (!m) return trimmed;
  try {
    const bin = atob(m[1].trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return trimmed;
  }
}

function parseContentDisposition(value: string): string | null {
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fallthrough */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
  return plain ? plain[1].trim() : null;
}

function parseUserinfo(value: string): TrafficInfo | null {
  const out: Record<string, number> = {};
  for (const part of value.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    if (!rawKey || rawValue == null) continue;
    const n = Number(rawValue.trim());
    if (Number.isFinite(n)) out[rawKey.trim().toLowerCase()] = n;
  }
  if (out.total == null && out.upload == null && out.download == null) return null;
  return {
    upload: out.upload ?? 0,
    download: out.download ?? 0,
    total: out.total ?? 0,
    expire: out.expire ?? 0,
  };
}

/** 去掉文件名后缀、首尾空白；空字符串按「没拿到」处理。 */
function sanitizeName(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/\.(ya?ml|txt|conf)$/i, '').trim();
  return cleaned || null;
}

export function parseSubscriptionMeta(headers: SubscriptionHeaders): SubscriptionMeta {
  let name: string | null = null;

  if (headers.profileTitle) {
    name = sanitizeName(decodeMaybeBase64(headers.profileTitle));
  }
  if (!name && headers.contentDisposition) {
    name = sanitizeName(parseContentDisposition(headers.contentDisposition));
  }

  const interval = Number((headers.profileUpdateInterval ?? '').trim());
  return {
    name: name || null,
    traffic: headers.subscriptionUserinfo ? parseUserinfo(headers.subscriptionUserinfo) : null,
    updateIntervalHours: Number.isFinite(interval) && interval > 0 ? interval : null,
  };
}

// --- 订阅原文预览（内核没启动时也能看节点） ------------------------------

export interface PreviewNode {
  name: string;
  type: string;
  delay: number | null;
}

export interface PreviewGroup {
  name: string;
  type: string;
  now: string;
  nodes: PreviewNode[];
}

const TYPE_LABEL: Record<string, string> = {
  select: 'Selector',
  'url-test': 'URLTest',
  fallback: 'Fallback',
  'load-balance': 'LoadBalance',
  relay: 'Relay',
};

function asDict(v: unknown): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

/**
 * 从订阅原文解析出「节点分组」预览。
 *
 * 内核没启动时用这份数据把节点列表先画出来，避免用户导入完订阅后
 * 在「节点」页只看到一句「内核未连接」。连接后仍以内核返回为准。
 */
export function parseSubscriptionPreview(raw: string): PreviewGroup[] {
  if (!raw.trim()) return [];

  let doc: Record<string, any>;
  try {
    doc = asDict(yaml.load(raw));
  } catch {
    return [];
  }

  const proxyList = asArray(doc.proxies);
  const typeByName = new Map<string, string>();
  for (const p of proxyList) {
    const d = asDict(p);
    if (typeof d.name === 'string') typeByName.set(d.name, String(d.type ?? ''));
  }

  // group 名字 → 它是分组（预览里选中它等同于选中一个分组）
  const groupNames = new Set(
    asArray(doc['proxy-groups'])
      .map((g) => asDict(g).name)
      .filter((n): n is string => typeof n === 'string')
  );

  const toNode = (name: string): PreviewNode | null => {
    if (!name || isInfoNode(name)) return null;
    if (groupNames.has(name)) return { name, type: 'Group', delay: null };
    if (!typeByName.has(name)) return null;
    return { name, type: typeByName.get(name) ?? '', delay: null };
  };

  const groups = asArray(doc['proxy-groups']);
  if (groups.length === 0) {
    // 没有分组：把所有真实节点放进一个合成分组，至少能看见节点
    const nodes = proxyList
      .map((p) => asDict(p).name)
      .filter((n): n is string => typeof n === 'string')
      .filter((n) => !isInfoNode(n))
      .map((n) => ({ name: n, type: typeByName.get(n) ?? '', delay: null }));
    return nodes.length > 0
      ? [{ name: '全部节点', type: '', now: '', nodes }]
      : [];
  }

  const out: PreviewGroup[] = [];
  for (const g of groups) {
    const d = asDict(g);
    const name = typeof d.name === 'string' ? d.name : '';
    if (!name) continue;
    const nodes = asArray(d.proxies)
      .map(String)
      .map(toNode)
      .filter((n): n is PreviewNode => n != null);
    out.push({
      name,
      type: TYPE_LABEL[String(d.type ?? '')] ?? String(d.type ?? ''),
      now: typeof d.now === 'string' ? d.now : '',
      nodes,
    });
  }
  return out;
}

/**
 * 从订阅的 proxies / proxy-groups 里剔除信息节点，返回清理后的副本。
 *
 * 机场会把「剩余流量 / 套餐到期」这类条目伪装成节点塞进配置，不清理的话
 * 它们会出现在节点列表、托盘菜单里，用户还可能误选。PPClash 已经用响应头
 * 展示流量，所以这些伪节点直接丢掉。
 */
export function stripInfoNodes(
  proxies: unknown[],
  groups: unknown[]
): { proxies: unknown[]; groups: unknown[] } {
  const keptProxies = proxies.filter((p) => !isInfoNode(String(asDict(p).name ?? '')));
  // 全被过滤掉的极端情况：宁可原样保留，也不要生成一份没节点的配置
  const outProxies = keptProxies.length > 0 ? keptProxies : proxies;

  const outGroups = groups.map((g) => {
    const d = asDict(g);
    const list = asArray(d.proxies).map(String);
    if (list.length === 0) return d;
    const filtered = list.filter((n) => !isInfoNode(n));
    return { ...d, proxies: filtered.length > 0 ? filtered : list };
  });

  return { proxies: outProxies, groups: outGroups };
}

/** 订阅里节点的真实数量（过滤掉信息节点后）。 */
export function countRealNodes(raw: string): number {
  try {
    const doc = asDict(yaml.load(raw));
    return asArray(doc.proxies)
      .map((p) => asDict(p).name)
      .filter((n): n is string => typeof n === 'string' && !isInfoNode(n)).length;
  } catch {
    return 0;
  }
}

export interface SubscriptionRuleItem {
  index: number;
  type: string;
  payload: string;
  target: string;
  raw: string;
}

/** 把订阅里的 rules 数组拆成可展示/可覆盖的结构。 */
export function parseSubscriptionRules(raw: string): SubscriptionRuleItem[] {
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch {
    return [];
  }
  const rules = (doc as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules)) return [];
  return rules
    .map((entry, index) => {
      const text = String(entry).trim();
      if (!text) return null;
      const parts = text.split(',').map((p) => p.trim());
      if (parts[0] === 'MATCH') {
        return { index, type: 'MATCH', payload: '', target: parts[1] ?? '', raw: text };
      }
      return {
        index,
        type: parts[0] ?? '',
        payload: parts.length >= 3 ? parts[1] : parts.slice(1).join(','),
        target: parts.length >= 3 ? parts[2] : '',
        raw: text,
      };
    })
    .filter((x): x is SubscriptionRuleItem => Boolean(x));
}
