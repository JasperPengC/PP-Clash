import { beforeAll, describe, expect, it } from 'vitest';
import { auditSubscription } from '../src/core/audit';
import { generateConfig } from '../src/core/generator';
import { DEFAULT_POLICY, type SecurityPolicy } from '../src/core/security';

/** 一份「典型的有问题订阅」：机场给的 DNS 段几乎每一条都是泄漏源。 */
const BAD_SUBSCRIPTION = `
proxies:
  - {name: 节点1, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-128-gcm, password: x}
proxy-groups:
  - {name: 机场, type: select, proxies: [节点1]}
rules:
  - DOMAIN-SUFFIX,google.com,机场
  - MATCH,机场
dns:
  enable: true
  nameserver: [223.5.5.5, 8.8.8.8]
  fallback: [https://223.5.5.5/dns-query]
  respect-rules: false
ipv6: true
tun:
  enable: true
  strict-route: false
`;

const CLEAN_SUBSCRIPTION = `
proxies: []
proxy-groups: []
rules: []
dns:
  enable: true
  nameserver: [https://1.1.1.1/dns-query]
  fallback: []
  respect-rules: true
ipv6: false
`;

function parse(config: string): Record<string, any> {
  return JSON.parse(config);
}

describe('配置生成', () => {
  let cfg: Record<string, any>;
  let stats: { proxyCount: number; groupCount: number; ruleCount: number; guardRuleCount: number };

  beforeAll(async () => {
    const out = await generateConfig(BAD_SUBSCRIPTION, DEFAULT_POLICY);
    cfg = parse(out.config);
    stats = out.stats;
  });

  it('订阅里的明文 DNS 和 fallback 会被覆盖掉', async () => {
    expect(cfg.dns.fallback).toEqual([]);
    expect(cfg.dns['respect-rules']).toBe(true);
    expect(JSON.stringify(cfg.dns.nameserver)).not.toContain('223.5.5.5');
  });

  it('IPv6 被强制关闭', async () => {
    expect(cfg.ipv6).toBe(false);
    expect(cfg.dns.ipv6).toBe(false);
  });

  it('TUN 开启严格路由', async () => {
    expect(cfg.tun['strict-route']).toBe(true);
  });

  it('防泄漏规则排在订阅规则之前', async () => {
    const rules: string[] = cfg.rules;
    expect(rules[0]).toContain('stun');
    const matchIndex = rules.findIndex((r) => r.startsWith('MATCH'));
    expect(matchIndex).toBe(rules.length - 1);
  });

  it('订阅的节点和业务规则被完整保留', async () => {
    expect(cfg.proxies).toHaveLength(1);
    expect(cfg['proxy-groups']).toHaveLength(1);
    expect(cfg.rules).toContain('DOMAIN-SUFFIX,google.com,机场');
  });

  it('统计数字与实际内容一致', async () => {
    expect(stats.proxyCount).toBe(1);
    expect(stats.groupCount).toBe(1);
    expect(stats.ruleCount).toBe(2);
    expect(stats.guardRuleCount).toBeGreaterThan(0);
  });
});

describe('订阅体检', () => {
  it('能识别出明文 DNS / fallback / respect-rules / IPv6 / strict-route', async () => {
    const findings = auditSubscription(BAD_SUBSCRIPTION);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('PLAINTEXT_DNS');
    expect(codes).toContain('FALLBACK_SET');
    expect(codes).toContain('NO_RESPECT_RULES');
    expect(codes).toContain('IPV6_ENABLED');
    expect(codes).toContain('NO_STRICT_ROUTE');
  });

  it('干净订阅不会误报', async () => {
    expect(auditSubscription(CLEAN_SUBSCRIPTION)).toHaveLength(0);
  });

  it('非法 YAML 不抛异常', async () => {
    expect(auditSubscription('{{{{ broken')).toEqual([]);
  });
});

describe('安全策略开关', () => {
  it('关掉 DNS 防泄漏后不再写 nameserver-policy', async () => {
    const policy: SecurityPolicy = { ...DEFAULT_POLICY, dnsLeakProtection: false };
    const cfg = parse((await generateConfig(BAD_SUBSCRIPTION, policy)).config);
    expect(cfg.dns['nameserver-policy']).toBeUndefined();
    expect(cfg.dns['enhanced-mode']).toBe('normal');
  });

  it('关掉 WebRTC 阻断后不再生成 STUN 规则', async () => {
    const policy: SecurityPolicy = { ...DEFAULT_POLICY, blockWebRtc: false };
    const cfg = parse((await generateConfig(BAD_SUBSCRIPTION, policy)).config);
    expect(cfg.rules.some((r: string) => r.includes('stun'))).toBe(false);
  });

  it('开启 QUIC 阻断只拦 UDP/443，不误伤 HTTPS', async () => {
    const policy: SecurityPolicy = { ...DEFAULT_POLICY, blockQuic: true };
    const cfg = parse((await generateConfig(BAD_SUBSCRIPTION, policy)).config);
    const rule = cfg.rules.find((r: string) => r.includes('NETWORK,UDP'));
    expect(rule).toBe('AND,((NETWORK,UDP),(DST-PORT,443)),REJECT-DROP');
    expect(cfg.rules).not.toContain('DST-PORT,443,REJECT-DROP');
  });

  it('TUN 开关透传到配置', async () => {
    const cfg = parse(
      (
        await generateConfig(BAD_SUBSCRIPTION, DEFAULT_POLICY, {
          mixedPort: 7890,
          controllerPort: 9090,
          controllerSecret: '',
          tunEnabled: true,
          mode: 'rule',
        })
      ).config
    );
    expect(cfg.tun.enable).toBe(true);
  });
});
