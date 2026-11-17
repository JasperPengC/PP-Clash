import { describe, expect, it } from 'vitest';
import { generateConfig, STABLE_EGRESS_DOMAINS, STABLE_EGRESS_GROUP, findStableEgressGroup } from '../src/core/generator';
import { DEFAULT_POLICY } from '../src/core/security';

const RAW = `proxies:
  - {name: NodeA, type: ss, server: a.example.com, port: 1, cipher: aes-256-gcm, password: p}
proxy-groups:
  - {name: G, type: select, proxies: [NodeA]}
rules:
  - DOMAIN-SUFFIX,example.com,DIRECT
`;

const RUNTIME = {
  mixedPort: 17890,
  controllerPort: 19090,
  controllerSecret: '',
  tunEnabled: false,
  mode: 'rule' as const,
  allowLan: false,
  dnsPort: 10530,
};

describe('运行参数与覆写', () => {
  it.each(['db', 'dat'] as const)('GEOIP %s 模式写入内核，GeoSite 与 ASN 来源独立保留', async geoDataMode => {
    const geoUrls = {
      geoip: 'https://example.com/geoip.dat', geosite: 'https://example.com/geosite.dat',
      mmdb: 'https://example.com/geoip.metadb', asn: 'https://example.com/ASN.mmdb',
      country: 'https://example.com/country.mmdb',
    };
    const cfg = JSON.parse((await generateConfig(RAW, DEFAULT_POLICY, { ...RUNTIME, geoDataMode, geoUrls })).config);
    expect(cfg['geodata-mode']).toBe(geoDataMode === 'dat');
    expect(cfg['geox-url']).toEqual({ geoip: geoUrls.geoip, geosite: geoUrls.geosite, mmdb: geoUrls.mmdb, asn: geoUrls.asn });
    expect(Object.keys(cfg.dns['nameserver-policy'])).toContain('geosite:cn,private');
  });

  it('忽略旧版本的 GitHub 固定出口参数，保留订阅原有 GitHub 规则', async () => {
    const raw = RAW.replace('  - DOMAIN-SUFFIX,example.com,DIRECT', '  - DOMAIN-SUFFIX,github.com,G');
    const out = await generateConfig(raw, DEFAULT_POLICY, {
      ...RUNTIME,
      stableEgress: { enabled: true, node: 'NodeA', domains: ['github.com'] },
    } as unknown as Parameters<typeof generateConfig>[2]);
    const cfg = JSON.parse(out.config);
    expect(cfg.rules).toContain('DOMAIN-SUFFIX,github.com,G');
    expect(cfg['proxy-groups'].map((group: { name: string }) => group.name)).toEqual(['G']);
  });

  it('不会因分组名称包含开发而额外管理其自动测速策略', async () => {
    const raw = RAW.replace('rules:', '  - {name: 开发, type: url-test, proxies: [NodeA], interval: 30}\nrules:');
    const generated = await generateConfig(raw, DEFAULT_POLICY, { ...RUNTIME, stableRouting: false });
    expect(JSON.parse(generated.config)['proxy-groups'].find((g: any) => g.name === '开发').type).toBe('url-test');
    expect(generated.routing.managed).not.toContain('开发');
  });
  it('主路由元数据来自最终覆写，供概览、后台与托盘共用', async () => {
    const generated = await generateConfig(RAW, DEFAULT_POLICY, { ...RUNTIME, stableRouting: true }, [{ mode: 'yaml', text: `proxy-groups:
  - {name: NewMain, type: select, proxies: [NewAuto]}
  - {name: NewAuto, type: fallback, proxies: [NodeA], url: https://example.com}
rules: ["MATCH,NewMain"]` }]);
    expect(generated.routing).toEqual({ primary: 'NewMain', managed: ['NewMain', 'NewAuto'], roots: ['NewMain'] });
  });
  it('稳定出口模式不会因延迟差异自动换节点，同时保留分组与手动选择', async () => {
    const raw = RAW.replace('type: select', 'type: url-test, url: https://example.com, interval: 30');
    const stable = JSON.parse((await generateConfig(raw, DEFAULT_POLICY, { ...RUNTIME, stableRouting: true })).config);
    expect(stable['proxy-groups'][0]).toMatchObject({ name: 'G', type: 'select', proxies: ['NodeA'] });
    expect(stable['proxy-groups'][0].interval).toBeUndefined();
    const original = JSON.parse((await generateConfig(raw, DEFAULT_POLICY, { ...RUNTIME, stableRouting: false })).config);
    expect(original['proxy-groups'][0].type).toBe('url-test');
  });
  it('独立 fallback 和负载均衡仍保留内核恢复以及 provider 健康检查', async () => {
    const raw = `${RAW}\nproxy-providers:\n  P: {type: http, url: https://example.com/nodes, health-check: {enable: true, url: https://example.com, interval: 300}}\n`;
    const override = { mode: 'yaml' as const, text: `proxy-groups:
  - {name: G, type: select, proxies: [Auto]}
  - {name: Auto, type: url-test, proxies: [NodeA]}
  - {name: Media, type: fallback, use: [P], url: https://example.com, interval: 60}
  - {name: Balance, type: load-balance, use: [P]}
rules: [MATCH,G]` };
    // MATCH 规则必须是一条字符串，不能误写成两个 YAML 列表成员。
    override.text = override.text.replace('rules: [MATCH,G]', 'rules: ["MATCH,G"]');
    const cfg = JSON.parse((await generateConfig(raw, DEFAULT_POLICY, { ...RUNTIME, stableRouting: true }, [override])).config);
    expect(cfg['proxy-groups'].find((g: any) => g.name === 'Auto').type).toBe('select');
    expect(cfg['proxy-groups'].find((g: any) => g.name === 'Media').type).toBe('fallback');
    expect(cfg['proxy-providers'].P['health-check'].enable).toBe(true);
  });
  it('DNS 监听端口可配置', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, RUNTIME);
    const cfg = JSON.parse(out.config);
    expect(cfg.dns.listen).toBe('127.0.0.1:10530');
  });

  it('局域网开关写进 allow-lan', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, { ...RUNTIME, allowLan: true, authUser: 'demo', authPass: 'demo' });
    const cfg = JSON.parse(out.config);
    expect(cfg['allow-lan']).toBe(true);
  });

  it('覆写对象深合并、数组整体替换', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, RUNTIME, [
      {
        mode: 'yaml',
        text: `rules:\n  - DOMAIN-SUFFIX,override.test,DIRECT\ndns:\n  listen: "127.0.0.1:10531"\n`,
      },
    ]);
    const cfg = JSON.parse(out.config);
    expect(cfg.rules).toEqual(['DOMAIN-SUFFIX,override.test,DIRECT']);
    expect(cfg.dns.listen).toBe('127.0.0.1:10531');
    // 未覆写的键保留
    expect(cfg['mixed-port']).toBe(17890);
  });

  it('覆写里的出站模式生效', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, RUNTIME, [{ mode: 'yaml', text: `mode: global\n` }]);
    const cfg = JSON.parse(out.config);
    expect(cfg.mode).toBe('global');
  });
});

describe('自定义规则与 JS 覆写', () => {
  it('自定义规则插在防护规则之后、订阅规则之前', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, {
      ...RUNTIME,
      customRules: [
        { id: 'r1', type: 'DOMAIN-SUFFIX', payload: 'custom.test', target: 'DIRECT', enabled: true },
      ],
    });
    const cfg = JSON.parse(out.config);
    const i = cfg.rules.indexOf('DOMAIN-SUFFIX,custom.test,DIRECT');
    expect(i).toBeGreaterThan(0);
    expect(cfg.rules[i + 1]).toBe('DOMAIN-SUFFIX,example.com,DIRECT');
  });

  it('JS 覆写可以修改配置对象', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, RUNTIME, [
      { mode: 'js', text: 'config.mode = "global"; config["log-level"] = "debug";' },
    ]);
    const cfg = JSON.parse(out.config);
    expect(cfg.mode).toBe('global');
    expect(cfg['log-level']).toBe('debug');
  });
});

describe('多文件覆写', () => {
  it('按顺序应用，后面的覆盖前面的', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, RUNTIME, [
      { mode: 'yaml', text: 'mode: global\ndns:\n  listen: "127.0.0.1:10531"\n' },
      { mode: 'yaml', text: 'mode: direct\n' },
    ]);
    const cfg = JSON.parse(out.config);
    expect(cfg.mode).toBe('direct');
    expect(cfg.dns.listen).toBe('127.0.0.1:10531');
  });
});

describe('自定义规则（结构化）', () => {
  it('MATCH 规则只输出两段', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, {
      ...RUNTIME,
      customRules: [{ id: 'm', type: 'MATCH', payload: '', target: 'G', enabled: true }],
    });
    const cfg = JSON.parse(out.config);
    expect(cfg.rules).toContain('MATCH,G');
  });

  it('当前节点占位符会解析成实际节点名', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, {
      ...RUNTIME,
      currentNode: 'NodeA',
      customRules: [
        { id: 'c', type: 'DOMAIN-SUFFIX', payload: 'x.test', target: '__CURRENT__', enabled: true },
      ],
    });
    const cfg = JSON.parse(out.config);
    expect(cfg.rules).toContain('DOMAIN-SUFFIX,x.test,NodeA');
  });

  it('覆写里的 {{CURRENT_NODE}} 会被替换', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, { ...RUNTIME, currentNode: 'NodeA' }, [
      { mode: 'yaml', text: 'proxy-groups:\n  - {name: Cur, type: select, proxies: ["{{CURRENT_NODE}}"]}\n' },
    ]);
    const cfg = JSON.parse(out.config);
    expect(cfg['proxy-groups'][0].proxies).toEqual(['NodeA']);
  });
});

describe('DNS 与嗅探', () => {
  it('自定义 DNS 会放在 nameserver 首位', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, {
      ...RUNTIME,
      dnsNameserver: 'custom',
      dnsCustom: 'https://dns.example/dns-query',
    });
    const cfg = JSON.parse(out.config);
    expect(cfg.dns.nameserver[0]).toBe('https://dns.example/dns-query');
  });

  it('预设 DNS 使用对应 DoH 地址', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, { ...RUNTIME, dnsNameserver: 'google' });
    const cfg = JSON.parse(out.config);
    expect(cfg.dns.nameserver).toContain('https://dns.google/dns-query');
  });

  it('开启嗅探会写入 sniffer 配置', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, {
      ...RUNTIME,
      snifferEnabled: true,
      snifferOverrideDestination: true,
    });
    const cfg = JSON.parse(out.config);
    expect(cfg.sniffer.enable).toBe(true);
    expect(cfg.sniffer['override-destination']).toBe(true);
    expect(cfg.sniffer.sniff.TLS.ports).toContain(443);
  });
  it('关闭嗅探时不会偷偷启用', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, { ...RUNTIME, snifferEnabled: false });
    const cfg = JSON.parse(out.config);
    expect(cfg.sniffer.enable).toBe(false);
  });

});

describe('额外端口与认证', () => {
  it('SOCKS / HTTP / Redir / bind-address / authentication', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, {
      ...RUNTIME,
      socksPort: 1080,
      httpPort: 8088,
      redirPort: 0,
      bindAddress: '0.0.0.0',
      authUser: 'pp',
      authPass: 'clash',
    });
    const cfg = JSON.parse(out.config);
    expect(cfg['socks-port']).toBe(1080);
    expect(cfg['port']).toBe(8088);
    expect(cfg['redir-port']).toBe(0);
    expect(cfg['bind-address']).toBe('0.0.0.0');
    expect(cfg.authentication).toEqual(['pp:clash']);
  });
});

describe('订阅规则编辑', () => {
  const RAW_RULES = `proxies:
  - {name: NodeA, type: ss, server: a.example.com, port: 1, cipher: aes-256-gcm, password: p}
proxy-groups:
  - {name: G, type: select, proxies: [NodeA]}
rules:
  - DOMAIN,a.example.com,DIRECT
  - DOMAIN,b.example.com,REJECT
  - MATCH,DIRECT
`;

  it('可以排序、停用和覆盖目标', async () => {
    const out = await generateConfig(RAW_RULES, DEFAULT_POLICY, RUNTIME, undefined, {
      order: [2, 0, 1],
      edits: {
        0: { target: 'G' },
        1: { enabled: false },
        2: { target: 'G' },
      },
    });
    const rules: string[] = JSON.parse(out.config).rules;
    const match = rules.findIndex((r) => r.startsWith('MATCH'));
    const domainA = rules.findIndex((r) => r.startsWith('DOMAIN,a.example.com'));
    expect(domainA).toBeGreaterThan(0);
    expect(rules[domainA]).toBe('DOMAIN,a.example.com,G');
    expect(rules.some((r) => r.startsWith('DOMAIN,b.example.com'))).toBe(false);
    expect(rules[match]).toBe('MATCH,G');
    expect(out.stats.ruleCount).toBe(2);
  });

  it('缺省规则保持原顺序', async () => {
    const out = await generateConfig(RAW_RULES, DEFAULT_POLICY, RUNTIME);
    const rules: string[] = JSON.parse(out.config).rules;
    expect(rules.filter((r) => r.startsWith('DOMAIN,')).map((r) => r.split(',')[1])).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });
});

describe.skip('已移除的 GitHub 固定出口', () => {
  it('启用后给 GitHub 域名加固定节点组，并排在规则最前面', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, {
      ...RUNTIME,
      stableEgress: { enabled: true, node: 'NodeA', domains: STABLE_EGRESS_DOMAINS },
    });
    const cfg = JSON.parse(out.config);
    const group = cfg['proxy-groups'].find((g: { name: string }) => g.name === STABLE_EGRESS_GROUP);
    expect(group).toMatchObject({ type: 'select', proxies: ['NodeA'] });
    expect(cfg.rules.slice(0, STABLE_EGRESS_DOMAINS.length)).toEqual(
      STABLE_EGRESS_DOMAINS.map((d) => `DOMAIN-SUFFIX,${d},${STABLE_EGRESS_GROUP}`)
    );
  });

  it('节点不存在时跳过固定组，不生成坏配置', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, {
      ...RUNTIME,
      stableEgress: { enabled: true, node: 'Missing', domains: STABLE_EGRESS_DOMAINS },
    });
    const cfg = JSON.parse(out.config);
    expect(cfg.rules.some((r: string) => r.includes(STABLE_EGRESS_GROUP))).toBe(false);
    expect(cfg['proxy-groups'].some((g: { name: string }) => g.name === STABLE_EGRESS_GROUP)).toBe(false);
  });
  it('订阅已有 GitHub 分组时复用，不重复追加', async () => {
    const raw = `proxies:\n  - {name: NodeA, type: ss, server: a.example.com, port: 1, cipher: aes-256-gcm, password: p}\nproxy-groups:\n  - {name: GitHub, type: select, proxies: [NodeA]}\nrules: []\n`;
    const out = await generateConfig(raw, DEFAULT_POLICY, {
      ...RUNTIME,
      stableEgress: { enabled: true, node: 'NodeA', domains: STABLE_EGRESS_DOMAINS },
    });
    const cfg = JSON.parse(out.config);
    expect(findStableEgressGroup(cfg['proxy-groups'])).toBe('GitHub');
    expect(cfg['proxy-groups'].filter((g: { name: string }) => g.name === STABLE_EGRESS_GROUP)).toHaveLength(0);
    expect(cfg.rules[0]).toBe(`DOMAIN-SUFFIX,github.com,GitHub`);
  });

  it('没有 GitHub 分组时才追加固定出口', async () => {
    const out = await generateConfig(RAW, DEFAULT_POLICY, {
      ...RUNTIME,
      stableEgress: { enabled: true, node: 'NodeA', domains: STABLE_EGRESS_DOMAINS },
    });
    const cfg = JSON.parse(out.config);
    expect(findStableEgressGroup(cfg['proxy-groups'])).toBeNull();
    expect(cfg['proxy-groups'].some((g: { name: string }) => g.name === STABLE_EGRESS_GROUP)).toBe(true);
  });

  it('追加的固定出口分组保留全部节点，固定节点排第一', async () => {
    const raw = `proxies:\n  - {name: NodeA, type: ss, server: a.example.com, port: 1, cipher: aes-256-gcm, password: p}\n  - {name: NodeB, type: ss, server: b.example.com, port: 2, cipher: aes-256-gcm, password: p}\nproxy-groups:\n  - {name: G, type: select, proxies: [NodeA, NodeB]}\nrules: []\n`;
    const out = await generateConfig(raw, DEFAULT_POLICY, {
      ...RUNTIME,
      stableEgress: { enabled: true, node: 'NodeB', domains: STABLE_EGRESS_DOMAINS },
    });
    const cfg = JSON.parse(out.config);
    const group = cfg['proxy-groups'].find((g: { name: string }) => g.name === STABLE_EGRESS_GROUP);
    expect(group.proxies[0]).toBe('NodeB');
    expect(group.proxies).toEqual(['NodeB', 'NodeA']);
  });

});
