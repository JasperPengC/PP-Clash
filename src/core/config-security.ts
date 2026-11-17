import type { Finding } from './audit';
import { buildGuardRules, type SecurityPolicy } from './security';
import { isLoopbackAddress } from './listen-address';

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict => value && typeof value === 'object' && !Array.isArray(value) ? value as Dict : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const loopback = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/i;
const encrypted = (value: unknown) => typeof value === 'string' && /^(?:https|tls|quic|h3):\/\//i.test(value);

function isLoopbackPrefix(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = /^([0-9a-f:.]+)\/(0|[1-9]\d{0,2})$/i.exec(value);
  if (!match) return false;
  const [, address, length] = match;
  const bits = Number(length);
  const ipv4 = (text: string) => {
    const octets = text.split('.');
    return octets.length === 4 && octets.every(octet => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
  };
  if (!address.includes(':')) {
    // 只有完整十进制 IPv4；URL 接受的短写、八进制形式不属于合法 CIDR。
    return ipv4(address) && isLoopbackAddress(address) && bits >= 8 && bits <= 32;
  }
  if (bits > 128 || (address.includes('.') && !ipv4(address.slice(address.lastIndexOf(':') + 1)))) return false;
  if (!isLoopbackAddress(address)) return false;
  try {
    const normalized = new URL(`http://[${address}]/`).hostname;
    // ::1 是单一地址，/127 已含非回环；IPv4 映射的 127/8 至少需要 96+8 位。
    if (normalized === '[::1]') return bits === 128;
    return /^\[::ffff:[0-9a-f]+:[0-9a-f]+\]$/i.test(normalized) && bits >= 104;
  } catch {
    return false;
  }
}

/** 最终配置的端口安全底线不受覆写顺序影响。 */
export function validateConfigExposure(config: Dict): void {
  for (const key of ['external-controller', 'external-controller-tls']) {
    const address = config[key];
    if (address && (typeof address !== 'string' || !loopback.test(address)))
      throw new Error('控制器仅允许监听本机回环地址，请检查覆写');
  }
  if (config['allow-lan'] === true) {
    const auth = list(config.authentication);
    if (!auth.length || auth.some(value => typeof value !== 'string' || !/^[^:\s]+:\S+$/.test(value)))
      throw new Error('局域网代理需要非空用户名和密码认证，请检查覆写');
    const exemptions = config['skip-auth-prefixes'];
    if (exemptions !== undefined && (!Array.isArray(exemptions) || !exemptions.every(isLoopbackPrefix)))
      throw new Error('局域网代理认证豁免仅允许完整回环 CIDR，请检查 skip-auth-prefixes 覆写');
  }
}

/** 核验生成后的配置，不把用户偏好或原订阅审计冒充运行效果。 */
export function auditFinalConfig(config: Dict, policy: SecurityPolicy, tunRequested: boolean): Finding[] {
  const findings: Finding[] = [];
  const add = (code: string, message: string) => findings.push({ code: `FINAL_${code}`, message, severity: 'high' });
  const dns = dict(config.dns);
  const tun = dict(config.tun);
  if (!policy.ipv6 && (config.ipv6 === true || dns.ipv6 === true)) add('IPV6', '最终配置开启了 IPv6，与隔离设置不一致');
  if (policy.dnsLeakProtection) {
    const nameservers = list(dns.nameserver);
    const directNameservers = list(dns['direct-nameserver']);
    const policies = Object.values(dict(dns['nameserver-policy'])).flatMap(value => Array.isArray(value) ? value : [value]);
    if (dns.enable !== true || dns['respect-rules'] !== true || !nameservers.length ||
      ![...nameservers, ...directNameservers, ...policies].every(encrypted) || list(dns.fallback).length > 0)
      add('DNS', '最终 DNS 配置未满足加密解析和跟随规则设置');
  }
  if (policy.fakeIp && (dns.enable !== true || dns['enhanced-mode'] !== 'fake-ip')) add('FAKE_IP', '最终配置未启用 Fake-IP');
  if (tunRequested && (tun.enable !== true || tun['auto-route'] !== true || !list(tun['dns-hijack']).includes('any:53') ||
    (policy.tunStrictRoute && tun['strict-route'] !== true)))
    add('TUN', '最终 TUN 配置与接管、DNS 劫持或严格路由设置不一致');
  const rules = list(config.rules).map(String);
  const guards = buildGuardRules(policy);
  const allowedPrefix = new Set(guards);
  const prioritized = (required: string[]) => required.every(rule => {
    const index = rules.indexOf(rule);
    return index >= 0 && rules.slice(0, index).every(before => allowedPrefix.has(before));
  });
  // 固定出口和用户前置路由均可能先选中出口，不能仅凭阻断规则存在就确认优先级。
  if (policy.blockWebRtc && (config.mode !== 'rule' || !prioritized(buildGuardRules({ ...policy, blockQuic: false })))) add('STUN', 'STUN 阻断规则缺失、优先级未确认或当前非规则模式');
  if (policy.blockQuic && (config.mode !== 'rule' || !prioritized(buildGuardRules({ ...policy, blockWebRtc: false })))) add('QUIC', 'QUIC 阻断规则缺失、受前置路由（含固定出口）限制或当前非规则模式');
  return findings;
}
