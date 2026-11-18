import { expect, it } from 'vitest';
import { generateConfig } from '../src/core/generator';
import { DEFAULT_POLICY } from '../src/core/security';
import { validateConfigExposure } from '../src/core/config-security';

const raw = `proxies: [{name: N, type: ss, server: example.test, port: 443, cipher: aes-128-gcm, password: synthetic}]
proxy-groups:
  - {name: Main, type: select, proxies: [N]}
  - {name: GitHub, type: select, proxies: [N]}
rules: ["MATCH,Main"]`;
const runtime = { mixedPort: 7890, controllerPort: 9090, controllerSecret: 'local-secret', tunEnabled: true, mode: 'rule' as const };
const lanConfig = { 'allow-lan': true, 'bind-address': '*', authentication: ['synthetic:synthetic-pass'] };

it.each([
  '0.0.0.0/0', '::/0', '192.168.0.0/16', '10.0.0.0/8', 'fc00::/7',
  '127.0.0.1/0', '127.255.255.255/7', '::1/127', '0:0:0:0:0:0:0:1/64',
  '::ffff:127.0.0.1/96', '::ffff:7f00:1/103', '::ffff:192.168.0.1/128',
])('LAN 不允许豁免覆盖非回环来源的 CIDR：%s', prefix => {
  expect(() => validateConfigExposure({ ...lanConfig, 'skip-auth-prefixes': [prefix] })).toThrow(/认证豁免/);
});
it.each([
  '127.0.0.0/8', '127.0.0.1/32', '127.255.255.255/24', '::1/128',
  '0:0:0:0:0:0:0:1/128', '::ffff:127.0.0.1/104', '::ffff:7f00:1/128',
])('LAN 允许整个 CIDR 都属于回环来源的豁免：%s', prefix => {
  expect(() => validateConfigExposure({ ...lanConfig, 'skip-auth-prefixes': [prefix] })).not.toThrow();
});
it.each([
  '127.0.0.1', 'localhost/32', '127.1/8', '0177.0.0.1/8', '127.0.0.999/8',
  '127.0.0.1/33', '127.0.0.1/-1', '127.0.0.1/08', '::1/129', '[::1]/128',
  '::1%lo0/128', ':::/128', '127.0.0.1/32 ', '::ffff:127.1/128', '',
])('LAN 拒绝无法明确解析的认证豁免：%s', prefix => {
  expect(() => validateConfigExposure({ ...lanConfig, 'skip-auth-prefixes': [prefix] })).toThrow(/认证豁免/);
});
it.each([null, '127.0.0.1/32', {}, [null], [123], ['127.0.0.1/32', '192.168.0.0/16']].map(prefixes => ({ prefixes })))('LAN 拒绝错误认证豁免结构：$prefixes', ({ prefixes }) => {
  expect(() => validateConfigExposure({ ...lanConfig, 'skip-auth-prefixes': prefixes })).toThrow(/认证豁免/);
});
it('缺省和空豁免不影响已认证 LAN，无 LAN 时不误阻豁免设置', () => {
  expect(() => validateConfigExposure(lanConfig)).not.toThrow();
  expect(() => validateConfigExposure({ ...lanConfig, 'skip-auth-prefixes': [] })).not.toThrow();
  expect(() => validateConfigExposure({ ...lanConfig, 'allow-lan': false, 'skip-auth-prefixes': ['0.0.0.0/0', '::/0'] })).not.toThrow();
  expect(() => validateConfigExposure({ 'skip-auth-prefixes': 'invalid-but-inactive' })).not.toThrow();
});
it('最终覆写不能用 LAN 网段认证豁免绕过底线', async () => {
  await expect(generateConfig(raw, DEFAULT_POLICY, runtime, [{ mode: 'yaml', text:
    'allow-lan: true\nbind-address: "*"\nauthentication: ["synthetic:synthetic-pass"]\nskip-auth-prefixes: ["0.0.0.0/0"]',
  }])).rejects.toThrow(/认证豁免/);
});
it('关闭固定出口不添加订阅原本没有的Github规则', async () => {
  const out = await generateConfig(raw, DEFAULT_POLICY, { ...runtime, stableEgress: { enabled: false, node: 'N', domains: ['github.com'] } });
  expect(JSON.parse(out.config).rules).not.toContain('DOMAIN-SUFFIX,github.com,GitHub');
});
it('覆写后的安全冲突必须反映在审计结果中', async () => {
  const out = await generateConfig(raw, { ...DEFAULT_POLICY, blockQuic: true }, runtime, [{ mode: 'yaml', text: `ipv6: true
dns: {respect-rules: false, nameserver: [223.5.5.5], fallback: [114.114.114.114], enhanced-mode: redir-host}
tun: {strict-route: false}
rules: ["MATCH,DIRECT"]` }]);
  expect(out.audit.map(f => f.code)).toEqual(expect.arrayContaining(['FINAL_IPV6', 'FINAL_DNS', 'FINAL_FAKE_IP', 'FINAL_TUN']));
  expect(out.audit.map(f => f.code)).not.toEqual(expect.arrayContaining(['FINAL_STUN', 'FINAL_QUIC']));
});
it.each([
  'external-controller: "0.0.0.0:9090"\nsecret: ""',
  'allow-lan: true\nbind-address: "*"\nauthentication: []',
])('阻止覆写开放未认证端口：%s', async text => {
  await expect(generateConfig(raw, DEFAULT_POLICY, runtime, [{ mode: 'yaml', text }])).rejects.toThrow(/控制器|认证/);
});
it('默认配置不会把必要的节点DNS引导误判成策略冲突', async () => {
  const out = await generateConfig(raw, DEFAULT_POLICY, runtime);
  expect(out.audit.filter(f => f.code.startsWith('FINAL_'))).toEqual([]);
});
it('保留订阅自带的Github规则，开关仅控制应用额外添加的规则', async () => {
  const source = raw.replace('rules: ["MATCH,Main"]', 'rules: ["DOMAIN-SUFFIX,github.com,GitHub", "MATCH,Main"]');
  const out = await generateConfig(source, DEFAULT_POLICY, { ...runtime, stableEgress: { enabled: false, node: 'N', domains: ['github.com'] } });
  expect(JSON.parse(out.config).rules.filter((rule: string) => rule === 'DOMAIN-SUFFIX,github.com,GitHub')).toHaveLength(1);
});
it('覆写替换 MATCH 目标时仍将应用防护规则保留在兜底之前', async () => {
  const out = await generateConfig(raw, DEFAULT_POLICY, runtime, [{ mode: 'yaml', text: 'rules: ["MATCH,DIRECT"]' }]);
  const rules: string[] = JSON.parse(out.config).rules;
  expect(rules.at(-1)).toBe('MATCH,DIRECT');
  expect(rules.findIndex(rule => rule.includes('stun'))).toBeLessThan(rules.findIndex(rule => rule.startsWith('MATCH,')));
  expect(out.audit.some(f => f.code === 'FINAL_STUN')).toBe(false);
});
it('明文直连解析器必须报告最终 DNS 配置不一致', async () => {
  const out = await generateConfig(raw, DEFAULT_POLICY, runtime, [{ mode: 'yaml', text: 'dns: {direct-nameserver: [192.0.2.53]}' }]);
  expect(out.audit.map(f => f.code)).toContain('FINAL_DNS');
});
it('加密直连解析器不会误报最终 DNS 冲突', async () => {
  const out = await generateConfig(raw, DEFAULT_POLICY, runtime, [{ mode: 'yaml', text: 'dns: {direct-nameserver: [https://example.test/dns-query]}' }]);
  expect(out.audit.map(f => f.code)).not.toContain('FINAL_DNS');
});
it('显式清空全局 TUN DNS 劫持时报告接管配置不一致', async () => {
  const out = await generateConfig(raw, DEFAULT_POLICY, runtime, [{ mode: 'yaml', text: 'tun: {dns-hijack: null}' }]);
  expect(out.audit.map(f => f.code)).toContain('FINAL_TUN');
});
it('空覆写数组不会清空应用默认配置', async () => {
  const out = await generateConfig(raw, DEFAULT_POLICY, runtime, [{ mode: 'yaml', text: 'tun: {dns-hijack: []}' }]);
  expect(out.audit.map(f => f.code)).not.toContain('FINAL_TUN');
});
it('覆写 TUN DNS 劫持列表时追加地址并保留应用默认接管地址', async () => {
  const out = await generateConfig(raw, DEFAULT_POLICY, runtime, [{ mode: 'yaml', text: 'tun: {dns-hijack: [192.0.2.53:53]}' }]);
  expect(out.audit.map(f => f.code)).not.toContain('FINAL_TUN');
});
it('移除固定出口后 GitHub 规则不会绕过 QUIC 阻断', async () => {
  const out = await generateConfig(raw, { ...DEFAULT_POLICY, blockQuic: true }, {
    ...runtime, stableEgress: { enabled: true, node: 'N', domains: ['github.com'] },
  });
  expect(JSON.parse(out.config).rules).not.toContain('DOMAIN-SUFFIX,github.com,GitHub');
  expect(out.audit.map(f => f.code)).not.toContain('FINAL_QUIC');
});
