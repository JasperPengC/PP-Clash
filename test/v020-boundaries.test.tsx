// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProxiesPage } from '../src/pages/Proxies';
import { SettingsPage } from '../src/pages/Settings';
import { useApp } from '../src/store/app';
import { api } from '../src/core/api';
import { generateConfig } from '../src/core/generator';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});

const raw = JSON.stringify({ proxies: ['A', 'B'].map(name => ({ name, type: 'socks5', server: 'fixture.invalid', port: 1080 })),
  'proxy-groups': [{ name: 'Main', type: 'select', proxies: ['A', 'B'] }], rules: ['MATCH,Main'] });
let host: HTMLDivElement;
let root: Root;
const pending: Array<() => void> = [];
const render = (page: typeof ProxiesPage | typeof SettingsPage) => act(async () => root.render(createElement(page)));
const groupTest = () => act(async () => host.querySelector<HTMLButtonElement>('.proxy-group-actions button')!.click());
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); pending.length = 0;
  Object.values(api).forEach(fn => vi.mocked(fn).mockResolvedValue(undefined));
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('ppclash.proxy.groups.open', JSON.stringify({ Main: true }));
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, activeId: 'fixture', connectedAt: 1, kernelPhase: 'running', notify: vi.fn(),
    settings: { ...initial.settings },
    profiles: [{ id: 'fixture', name: '测试订阅', url: 'https://fixture.invalid/', raw, updatedAt: 0, userinfo: null, updateIntervalHours: null }],
    groups: [{ name: 'Main', type: 'Selector', now: 'A', nodes: ['A', 'B', 'C', 'D'].map(name => ({ name, type: 'Socks5', delay: null })) }] });
  vi.mocked(api.listBackups).mockResolvedValue([]);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  await act(async () => { pending.splice(0).forEach(finish => finish()); });
  vi.useRealTimers();
});

it('节点页卸载重进共用3个在途槽，旧结果不发布', async () => {
  vi.mocked(api.mihomo).mockImplementation(() => new Promise(resolve => pending.push(() => resolve({ delay: 42 }))));
  await render(ProxiesPage); await groupTest();
  expect(pending).toHaveLength(3);
  await act(async () => root.render(null));
  await render(ProxiesPage); await groupTest();
  expect(pending).toHaveLength(3);
  await act(async () => { pending.splice(0).forEach(finish => finish()); });
  expect(pending).toHaveLength(3);
  expect(useApp.getState().groups[0].nodes[0].delay).toBeNull();
});

it('恢复成功至hydrate前，设置和其他persist来源不覆盖恢复状态', async () => {
  vi.useFakeTimers();
  let disk = '';
  const restored = JSON.stringify({ profiles: [], activeId: null, settings: { theme: 'light' } });
  vi.mocked(api.listBackups).mockResolvedValue([{ name: 'state-input.json', size: 64, mtimeMs: 1 }]);
  vi.mocked(api.restoreBackup).mockImplementation(async () => { disk = restored; });
  vi.mocked(api.saveAppState).mockImplementation(async content => { disk = content; });
  await render(SettingsPage);
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.settings-category')].find(button => button.textContent === '备份与恢复')!.click());
  const restore = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '恢复' || button.textContent === '确认恢复')!;
  await act(async () => restore().click());
  await act(async () => restore().click());
  expect(disk).toBe(restored);
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.settings-category')].find(button => button.textContent === '外观')!.click());
  const dark = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '深色')!;
  expect(dark.disabled).toBe(false);
  await act(async () => dark.click());
  await act(async () => useApp.getState().setSysProxyEnabled(true));
  expect(disk).toBe(restored);
});

async function arrangeRefresh() {
  let disk = (await generateConfig(raw, useApp.getState().policy)).config;
  let previous = disk;
  let candidate = '';
  vi.mocked(api.fetchSubscription).mockResolvedValue({ raw, profileTitle: null, contentDisposition: null, subscriptionUserinfo: null, profileUpdateInterval: null });
  vi.mocked(api.prepareConfig).mockImplementation(async text => { candidate = text; return '/isolated/candidate.yaml'; });
  vi.mocked(api.validateConfig).mockResolvedValue(undefined);
  vi.mocked(api.commitConfig).mockImplementation(async () => { previous = disk; disk = candidate; return '/isolated/config.yaml'; });
  vi.mocked(api.finishConfig).mockImplementation(async (_path, rollback) => { if (rollback) disk = previous; });
  let selected = 'A';
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (method === 'PUT' && path === '/proxies/Main') { selected = (body as { name: string }).name; return null; }
    return { proxies: {
    Main: { type: 'Selector', now: selected, all: ['A', 'B'] },
    'GitHub 固定出口': { type: 'Selector', now: 'B', all: ['A', 'B'] }, A: { type: 'Socks5' }, B: { type: 'Socks5' },
  } }; });
}

it('更新订阅时不会追加应用自带的 GitHub 固定出口组', async () => {
  await arrangeRefresh();
  expect(await useApp.getState().refreshProfile('fixture')).toBe(true);
  expect(useApp.getState().profiles[0].updatedAt).toBeGreaterThan(0);
  const generated = JSON.parse(vi.mocked(api.prepareConfig).mock.calls[0][0] as string);
  expect(generated['proxy-groups'].some((group: { name: string }) => group.name === 'GitHub 固定出口')).toBe(false);
});

it('热加载在途时的新固定意图在最新分组上执行并确认', async () => {
  await arrangeRefresh();
  let finishLoad!: () => void;
  vi.mocked(api.mihomo).mockImplementationOnce(() => new Promise(resolve => { finishLoad = () => resolve(null); }));
  const refresh = useApp.getState().refreshProfile('fixture');
  await vi.waitFor(() => expect(finishLoad).toBeTypeOf('function'));
  const fixed = useApp.getState().toggleFixedNode('Main', 'B');
  finishLoad();
  expect(await refresh).toBe(true);
  expect(await fixed).toBe(true);
  expect(useApp.getState().fixedNodes.fixture?.Main).toBe('B');
  expect(api.mihomo).toHaveBeenCalledWith('PUT', '/proxies/Main', { name: 'B' });
});

it('订阅热更新代次使旧队列和同名节点回包失效', async () => {
  await arrangeRefresh();
  const underlying = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation((...args) => args[1].includes('/delay?')
    ? new Promise(resolve => pending.push(() => resolve({ delay: 777 })))
    : underlying(...args));
  await render(ProxiesPage); await groupTest();
  expect(pending).toHaveLength(3);
  const nextRaw = raw.replaceAll('fixture.invalid', 'replacement.invalid');
  vi.mocked(api.fetchSubscription).mockResolvedValue({ raw: nextRaw, profileTitle: null, contentDisposition: null, subscriptionUserinfo: null, profileUpdateInterval: null });
  await act(async () => expect(await useApp.getState().refreshProfile('fixture')).toBe(true));
  expect(useApp.getState().profiles[0].raw).toBe(nextRaw);
  await act(async () => { pending.splice(0).forEach(finish => finish()); });
  expect(pending).toHaveLength(0);
  vi.useFakeTimers();
  await act(async () => { pending.splice(0).forEach(finish => finish()); });
  expect(useApp.getState().groups.find(group => group.name === 'Main')?.nodes.find(node => node.name === 'A')?.delay).not.toBe(777);
});

it('恢复失败时解除全局冻结并保存期间的新设置', async () => {
  let fail!: (error: Error) => void;
  vi.mocked(api.restoreBackup).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const restoring = useApp.getState().restoreBackup('state-input.json');
  useApp.getState().updateSettings({ theme: 'dark' });
  expect(api.saveAppState).not.toHaveBeenCalled();
  fail(new Error('fixture restore failed'));
  await expect(restoring).rejects.toThrow('fixture restore failed');
  expect(useApp.getState().persistenceFrozen).toBe(false);
  expect(JSON.parse(vi.mocked(api.saveAppState).mock.calls.at(-1)![0]).settings.theme).toBe('dark');
});

it('较旧hydrate迟到返回不能覆盖新hydrate或替换它的保存会话', async () => {
  let finishOld!: (value: string) => void;
  vi.mocked(api.loadAppState).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const old = useApp.getState().hydrate();
  await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));
  vi.mocked(api.loadAppState).mockResolvedValue(JSON.stringify({ profiles: [], settings: { theme: 'light' } }));
  await useApp.getState().hydrate();
  const session = vi.mocked(api.loadAppState).mock.calls.at(-1)![1];
  finishOld(JSON.stringify({ profiles: [], settings: { theme: 'dark' } }));
  await old;
  expect(useApp.getState().settings.theme).toBe('light');
  useApp.getState().updateSettings({ theme: 'system' });
  expect(vi.mocked(api.saveAppState).mock.calls.at(-1)![2]).toBe(session);
  expect(useApp.getState().persistenceFrozen).toBe(false);
});

it.each([false, true])('热加载过渡期丢弃旧测速、阻止新测速，回退=%s', async rollback => {
  await arrangeRefresh();
  const underlying = vi.mocked(api.mihomo).getMockImplementation()!;
  let finishLoad!: () => void;
  vi.mocked(api.mihomo).mockImplementation((...args) => {
    if (args[1].includes('/delay?')) return new Promise(resolve => pending.push(() => resolve({ delay: 777 })));
    if (args[1].startsWith('/configs') && !finishLoad) return new Promise((resolve, reject) => {
      finishLoad = () => rollback ? reject(new Error('fixture load rejected')) : resolve(null);
    });
    return underlying(...args);
  });
  await render(ProxiesPage); await groupTest();
  const refresh = useApp.getState().refreshProfile('fixture');
  await vi.waitFor(() => expect(finishLoad).toBeTypeOf('function'));
  await act(async () => { pending.splice(0).forEach(finish => finish()); });
  expect(pending).toHaveLength(0);
  expect(useApp.getState().groups[0].nodes[0].delay).toBeNull();
  const calls = vi.mocked(api.mihomo).mock.calls.length;
  expect(await useApp.getState().testDelay('A')).toBeNull();
  expect(api.mihomo).toHaveBeenCalledTimes(calls);
  await act(async () => { finishLoad(); expect(await refresh).toBe(!rollback); });
  expect(useApp.getState().runtimeConfigTransition).toBe(false);
});

it('普通路由选择代次改变不使同一运行配置测速失效', async () => {
  vi.mocked(api.mihomo).mockImplementation(() => new Promise(resolve => pending.push(() => resolve({ delay: 42 }))));
  const test = useApp.getState().testDelay('A');
  useApp.setState(s => ({ routeRevision: s.routeRevision + 1 }));
  pending.splice(0).forEach(finish => finish());
  expect(await test).toBe(42);
  expect(useApp.getState().groups[0].nodes[0].delay).toBe(42);
});

it('热加载期间较晚的固定意图胜出，不被旧排队请求回滚', async () => {
  await arrangeRefresh();
  let finishLoad!: () => void;
  vi.mocked(api.mihomo).mockImplementationOnce(() => new Promise(resolve => { finishLoad = () => resolve(null); }));
  const refresh = useApp.getState().refreshProfile('fixture');
  await vi.waitFor(() => expect(finishLoad).toBeTypeOf('function'));
  const previous = useApp.getState().toggleFixedNode('Main', 'B');
  const latest = useApp.getState().toggleFixedNode('Main', 'A');
  finishLoad();
  expect(await refresh).toBe(true);
  expect(await previous).toBe(false);
  expect(await latest).toBe(true);
  expect(useApp.getState().fixedNodes.fixture?.Main).toBe('A');
  expect(api.mihomo).not.toHaveBeenCalledWith('PUT', '/proxies/Main', { name: 'B' });
});

it('复用订阅GitHub组保持订阅选择语义，不强制egressGuardNode', async () => {
  await arrangeRefresh();
  useApp.setState(s => ({ settings: { ...s.settings, egressGuard: true, egressGuardNode: 'A' } }));
  const next = JSON.parse(raw);
  next['proxy-groups'].push({ name: 'GitHub', type: 'select', proxies: ['A', 'B'] });
  vi.mocked(api.fetchSubscription).mockResolvedValue({ raw: JSON.stringify(next), profileTitle: null, contentDisposition: null, subscriptionUserinfo: null, profileUpdateInterval: null });
  vi.mocked(api.mihomo).mockResolvedValue({ proxies: { Main: { type: 'Selector', now: 'A', all: ['A', 'B'] },
    GitHub: { type: 'Selector', now: 'B', all: ['A', 'B'] }, A: { type: 'Socks5' }, B: { type: 'Socks5' } } });
  expect(await useApp.getState().refreshProfile('fixture')).toBe(true);
  expect(useApp.getState().groups.find(group => group.name === 'GitHub')?.now).toBe('B');
});

it('覆写中用户自带的 GitHub 组按订阅配置正常更新', async () => {
  await arrangeRefresh();
  useApp.setState(s => ({ settings: { ...s.settings,
    overrides: [{ id: 'fixture-override', name: 'fixture', enabled: true, mode: 'yaml', text:
      'proxy-groups:\n  - name: GitHub 固定出口\n    type: select\n    proxies: [A, B]\n    default-selected: B' }] } }));
  expect(await useApp.getState().refreshProfile('fixture')).toBe(true);
  expect(api.commitConfig).toHaveBeenCalled();
  expect(useApp.getState().profiles[0].updatedAt).toBeGreaterThan(0);
});

it('恢复尚未结束时hydrate不能读取旧磁盘并解除冻结', async () => {
  let finishRestore!: () => void;
  vi.mocked(api.restoreBackup).mockImplementation(() => new Promise(resolve => { finishRestore = resolve; }));
  vi.mocked(api.loadAppState).mockResolvedValue(JSON.stringify({ profiles: [], settings: { theme: 'dark' } }));
  const restoring = useApp.getState().restoreBackup('state-input.json');
  await useApp.getState().hydrate();
  expect(api.loadAppState).not.toHaveBeenCalled();
  finishRestore(); await restoring;
  expect(useApp.getState().persistenceFrozen).toBe(true);
  await useApp.getState().hydrate();
  expect(useApp.getState().persistenceFrozen).toBe(false);
  expect(useApp.getState().settings.theme).toBe('dark');
});

it('普通hydrate被断开作废后释放自己的冻结，后续设置与恢复可用', async () => {
  let finishLoad!: (value: string) => void;
  vi.mocked(api.loadAppState).mockImplementation(() => new Promise(resolve => { finishLoad = resolve; }));
  const hydration = useApp.getState().hydrate();
  await vi.waitFor(() => expect(finishLoad).toBeTypeOf('function'));
  await useApp.getState().disconnect();
  finishLoad(JSON.stringify({ profiles: [], settings: { theme: 'dark' } }));
  await hydration;
  expect(useApp.getState().persistenceFrozen).toBe(false);
  vi.mocked(api.saveAppState).mockClear();
  useApp.getState().updateSettings({ theme: 'light' });
  expect(api.saveAppState).toHaveBeenCalled();
  await expect(useApp.getState().restoreBackup('state-input.json')).resolves.toBeUndefined();
});

it('重叠普通hydrate最新读取失败时释放冻结，旧读取不能重新发布', async () => {
  let finishOld!: (value: string) => void;
  vi.mocked(api.loadAppState).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const old = useApp.getState().hydrate();
  await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));
  vi.mocked(api.loadAppState).mockRejectedValueOnce(new Error('fixture load failed'));
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  await useApp.getState().hydrate();
  quiet.mockRestore();
  finishOld(JSON.stringify({ profiles: [], settings: { theme: 'dark' } }));
  await old;
  expect(useApp.getState().persistenceFrozen).toBe(false);
  expect(useApp.getState().settings.theme).not.toBe('dark');
  vi.mocked(api.saveAppState).mockClear();
  useApp.getState().updateSettings({ theme: 'light' });
  expect(api.saveAppState).toHaveBeenCalled();
});

it('旧hydrate收尾不能释放较新hydrate的冻结', async () => {
  const loads: Array<(value: string) => void> = [];
  vi.mocked(api.loadAppState).mockImplementation(() => new Promise(resolve => loads.push(resolve)));
  const old = useApp.getState().hydrate();
  await vi.waitFor(() => expect(loads).toHaveLength(1));
  const latest = useApp.getState().hydrate();
  await vi.waitFor(() => expect(loads).toHaveLength(2));
  loads[0](JSON.stringify({ profiles: [], settings: { theme: 'dark' } }));
  await old;
  expect(useApp.getState().persistenceFrozen).toBe(true);
  vi.mocked(api.saveAppState).mockClear();
  useApp.getState().updateSettings({ theme: 'system' });
  expect(api.saveAppState).not.toHaveBeenCalled();
  loads[1](JSON.stringify({ profiles: [], settings: { theme: 'light' } }));
  await latest;
  expect(useApp.getState().persistenceFrozen).toBe(false);
});

it.each(['failure', 'cancel'])('恢复成功后的hydrate %s保留恢复屏障直到成功水合', async action => {
  await useApp.getState().restoreBackup('state-input.json');
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  if (action === 'failure') {
    vi.mocked(api.loadAppState).mockRejectedValueOnce(new Error('fixture load failed'));
    await useApp.getState().hydrate();
  } else {
    let finishLoad!: (value: string) => void;
    vi.mocked(api.loadAppState).mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve; }));
    const hydration = useApp.getState().hydrate();
    await vi.waitFor(() => expect(finishLoad).toBeTypeOf('function'));
    await useApp.getState().disconnect();
    finishLoad(JSON.stringify({ profiles: [], settings: { theme: 'dark' } }));
    await hydration;
  }
  quiet.mockRestore();
  expect(useApp.getState().persistenceFrozen).toBe(true);
  vi.mocked(api.saveAppState).mockClear();
  useApp.getState().updateSettings({ theme: 'light' });
  expect(api.saveAppState).not.toHaveBeenCalled();
  vi.mocked(api.loadAppState).mockResolvedValueOnce(JSON.stringify({ profiles: [], settings: { theme: 'system' } }));
  await useApp.getState().hydrate();
  expect(useApp.getState().persistenceFrozen).toBe(false);
});

it('已接受旧读取的hydrate收尾不能解除后来恢复的屏障', async () => {
  let finishSave!: () => void;
  vi.mocked(api.loadAppState).mockResolvedValueOnce(JSON.stringify({ profiles: [], settings: { theme: 'light' } }));
  vi.mocked(api.saveAppState).mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
  const hydration = useApp.getState().hydrate();
  await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
  await useApp.getState().restoreBackup('state-input.json');
  finishSave(); await hydration;
  expect(useApp.getState().persistenceFrozen).toBe(true);
  expect(useApp.getState().restoredStatePending).toBe(true);
  vi.mocked(api.saveAppState).mockClear();
  useApp.getState().updateSettings({ theme: 'dark' });
  expect(api.saveAppState).not.toHaveBeenCalled();
});

it('初次hydrate读取失败只释放普通冻结，不把未水合空内存自动覆盖磁盘', async () => {
  const saved = JSON.stringify({ profiles: [{ id: 'on-disk', raw }], settings: { theme: 'dark' } });
  let disk = saved;
  useApp.setState({ profiles: [], activeId: null, persistenceSession: undefined });
  vi.mocked(api.saveAppState).mockImplementation(async content => { disk = content; });
  vi.mocked(api.loadAppState).mockRejectedValueOnce(new Error('fixture read denied'));
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  await useApp.getState().hydrate();
  quiet.mockRestore();
  expect(useApp.getState().persistenceFrozen).toBe(false);
  expect(api.saveAppState).not.toHaveBeenCalled();
  expect(disk).toBe(saved);
});
