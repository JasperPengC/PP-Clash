import { expect, it } from 'vitest';
import { generateConfig, DEFAULT_RUNTIME } from '../src/core/generator';
import { DEFAULT_POLICY } from '../src/core/security';
const raw = JSON.stringify({ proxies: ['A', 'B'].map(name => ({ name, type: 'socks5', server: '127.0.0.1', port: 1080 })),
  'proxy-groups': [{ name: 'Main', type: 'select', proxies: ['A', 'B'] }], rules: ['MATCH,Main'] });
it('固定节点写入TUN启动配置，排第一且不允许旧内核选择缓存覆盖', async () => {
  const result = JSON.parse((await generateConfig(raw, DEFAULT_POLICY, { ...DEFAULT_RUNTIME, tunEnabled: true, fixedNodes: { Main: 'B' } },
    [{ mode: 'yaml', text: 'profile: {store-selected: true}' }])).config);
  expect(result.tun.enable).toBe(true);
  expect(result['proxy-groups'][0].proxies).toEqual(['B', 'A']);
  expect(result['proxy-groups'][0]['default-selected']).toBe('B');
  expect(result.profile['store-selected']).toBe(false);
});
it('取消固定后恢复普通配置的内核选择缓存', async () => {
  const result = JSON.parse((await generateConfig(raw, DEFAULT_POLICY, { ...DEFAULT_RUNTIME, fixedNodes: {} })).config);
  expect(result.profile['store-selected']).toBe(true);
  expect(result['proxy-groups'][0].proxies).toEqual(['A', 'B']);
});
it.each([
  { name: 'Main', type: 'select', use: ['remote'] },
  { name: 'Main', type: 'select', proxies: ['A', 'B'], filter: 'A' },
  { name: 'Main', type: 'url-test', proxies: ['A', 'B'] },
])('TUN固定无法在启动前确定时拒绝生成，不能先走默认节点', async group => {
  const source = JSON.stringify({ ...JSON.parse(raw), 'proxy-groups': [group] });
  await expect(generateConfig(source, DEFAULT_POLICY, { ...DEFAULT_RUNTIME, stableRouting: false, tunEnabled: true, fixedNodes: { Main: 'B' } })).rejects.toThrow(/固定/);
});

it.each(['url-test', 'select'])('TUN固定目标本身为%s子组时拒绝声称锁定出口', async type => {
  const source = JSON.stringify({ ...JSON.parse(raw), 'proxy-groups': [
    { name: 'Main', type: 'select', proxies: ['Nested', 'A'] },
    { name: 'Nested', type, proxies: ['A', 'B'] },
  ] });
  await expect(generateConfig(source, DEFAULT_POLICY, { ...DEFAULT_RUNTIME, stableRouting: false, tunEnabled: true,
    fixedNodes: { Main: 'Nested' } })).rejects.toThrow(/固定/);
});

it('普通记忆通过默认选择恢复，不改变订阅节点顺序，也不共用内核全局缓存', async () => {
  const result = JSON.parse((await generateConfig(raw, DEFAULT_POLICY, { ...DEFAULT_RUNTIME, selectedNodes: { Main: 'B' } })).config);
  expect(result['proxy-groups'][0].proxies).toEqual(['A', 'B']);
  expect(result['proxy-groups'][0]['default-selected']).toBe('B');
  expect(result.profile['store-selected']).toBe(false);
});

it('显式固定优先于普通记忆，空记忆也关闭跨订阅选择缓存', async () => {
  const result = JSON.parse((await generateConfig(raw, DEFAULT_POLICY, {
    ...DEFAULT_RUNTIME, fixedNodes: { Main: 'A' }, selectedNodes: { Main: 'B' },
  })).config);
  expect(result['proxy-groups'][0]['default-selected']).toBe('A');
  const empty = JSON.parse((await generateConfig(raw, DEFAULT_POLICY, { ...DEFAULT_RUNTIME, selectedNodes: {} })).config);
  expect(empty.profile['store-selected']).toBe(false);
});

it.each([
  { name: 'Main', type: 'select', proxies: ['A'], },
  { name: 'Main', type: 'url-test', proxies: ['A', 'B'] },
  { name: 'Main', type: 'select', proxies: ['A', 'B'], filter: 'A' },
])('失效、自动或动态筛选分组不注入普通默认选择：$type', async group => {
  const source = JSON.stringify({ ...JSON.parse(raw), 'proxy-groups': [group] });
  const result = JSON.parse((await generateConfig(source, DEFAULT_POLICY, {
    ...DEFAULT_RUNTIME, stableRouting: false, selectedNodes: { Main: 'B', Removed: 'A' },
  })).config);
  expect(result['proxy-groups'][0]['default-selected']).toBeUndefined();
});
