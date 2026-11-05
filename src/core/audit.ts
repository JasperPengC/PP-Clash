import yaml from 'js-yaml';

export interface Finding {
  code: string;
  message: string;
  severity: 'high' | 'medium';
}

const PLAINTEXT_DNS = /(\d{1,3}\.){3}\d{1,3}/;
const SECURE_SCHEME = /^(https|tls|quic|h3|dhcp):\/\//i;

function isPlaintextDns(value: string): boolean {
  if (SECURE_SCHEME.test(value)) return false;
  return PLAINTEXT_DNS.test(value);
}

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * 体检订阅原文，找出它自己会造成的泄漏点。
 *
 * 用途：导入时告诉用户「这份订阅原本有 N 处会泄漏，已自动修正」。
 * 它不改变生成结果，只负责解释「为什么你不需要关心 DNS 配置」。
 */
export function auditSubscription(yamlText: string): Finding[] {
  let doc: Dict;
  try {
    doc = asDict(yaml.load(yamlText));
  } catch {
    return [];
  }

  const findings: Finding[] = [];
  const dns = asDict(doc.dns);

  // 1) nameserver / default-nameserver / fallback 里出现明文 DNS
  const plaintext: string[] = [];
  for (const key of ['nameserver', 'default-nameserver', 'fallback']) {
    for (const item of asArray(dns[key])) {
      const s = String(item);
      if (isPlaintextDns(s)) plaintext.push(s);
    }
  }
  if (plaintext.length > 0) {
    findings.push({
      code: 'PLAINTEXT_DNS',
      severity: 'high',
      message: `DNS 明文地址 ${plaintext.length} 个（${plaintext
        .slice(0, 2)
        .join('、')}）`,
    });
  }

  // 2) fallback 非空 —— mihomo 的 fallback 与 nameserver 是并发查询的
  const fallback = asArray(dns.fallback);
  if (fallback.length > 0) {
    findings.push({
      code: 'FALLBACK_SET',
      severity: 'high',
      message: `fallback 解析器 ${fallback.length} 个`,
    });
  }

  // 3) respect-rules 没开 —— DNS 查询不走代理
  if (dns['respect-rules'] !== true) {
    findings.push({
      code: 'NO_RESPECT_RULES',
      severity: 'high',
      message: 'DNS 未跟随代理规则',
    });
  }

  // 4) IPv6
  if (doc.ipv6 === true || dns.ipv6 === true) {
    findings.push({
      code: 'IPV6_ENABLED',
      severity: 'medium',
      message: 'IPv6 未隔离',
    });
  }

  // 5) TUN 严格路由
  const tun = asDict(doc.tun);
  if (tun.enable === true && tun['strict-route'] !== true) {
    findings.push({
      code: 'NO_STRICT_ROUTE',
      severity: 'medium',
      message: 'TUN 未开启严格路由',
    });
  }

  return findings;
}
