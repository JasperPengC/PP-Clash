// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { getRoutingRevision, useApp } from '../src/store/app';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});
let selected = 'A';
const profile = { id: 'p', name: 'fixture', url: '', raw: 'proxies: []\nproxy-groups: []\nrules: []', updatedAt: 0, userinfo: { total: 100, upload: 0, download: 0 }, updateIntervalHours: null };
const fixed = () => useApp.getState().fixedNodes?.p?.Main;
beforeEach(() => {
  vi.resetAllMocks(); selected = 'A';
  Object.values(api).forEach(fn => vi.mocked(fn).mockResolvedValue(undefined));
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, activeId: 'p', profiles: [profile], kernelPhase: 'running', connectedAt: 1,
    routing: { primary: 'Main', managed: ['Main'] },
    groups: [{ name: 'Main', type: 'Selector', now: 'A', nodes: ['A', 'B', 'C'].map(name => ({ name, type: 'Shadowsocks', delay: null })) }] });
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (method === 'PUT') { selected = (body as { name: string }).name; return {}; }
    if (path === '/proxies') return { proxies: { Main: { type: 'Selector', now: selected, all: ['A', 'B', 'C'] }, A: { type: 'Shadowsocks' }, B: { type: 'Shadowsocks' }, C: { type: 'Shadowsocks' } } };
    if (path === '/rules') return { rules: [{ type: 'Match', proxy: 'Main' }] };
    throw new Error(`unexpected ${method} ${path}`);
  });
  vi.mocked(api.prepareConfig).mockResolvedValue('/isolated/candidate.yaml');
  vi.mocked(api.commitConfig).mockResolvedValue('/isolated/config.yaml');
  vi.mocked(api.finishConfig).mockResolvedValue(undefined);
  vi.mocked(api.validateConfig).mockResolvedValue(undefined);
  vi.mocked(api.saveAppState).mockResolvedValue(undefined);
  vi.mocked(api.setTrayFlags).mockResolvedValue(undefined);
  vi.mocked(api.startKernel).mockResolvedValue({ running: true, pid: 123 });
  vi.mocked(api.stopKernel).mockResolvedValue({ running: false, pid: null });
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: false, port: 7890 });
  vi.mocked(api.setSystemProxy).mockImplementation(async (enabled, _host, port) => ({ enabled, port }));
});
afterEach(() => vi.useRealTimers());
const puts = () => vi.mocked(api.mihomo).mock.calls.filter(([method]) => method === 'PUT');

it('固定旗标先实际选择并验证该组节点，确认成功后唯一标记并持久化', async () => {
  expect(await useApp.getState().toggleFixedNode('Main', 'B')).toBe(true);
  expect(selected).toBe('B'); expect(fixed()).toBe('B');
  expect(useApp.getState().groups[0].now).toBe('B');
  expect(JSON.parse(vi.mocked(api.saveAppState).mock.calls.at(-1)![0]).fixedNodes).toEqual({ p: { Main: 'B' } });
  expect(await useApp.getState().toggleFixedNode('Main', 'C')).toBe(true);
  expect(fixed()).toBe('C'); expect(selected).toBe('C');
});
it.each(['request', 'confirmation'])('选择%s失败不能发布假固定', async failure => {
  if (failure === 'request') vi.mocked(api.mihomo).mockRejectedValueOnce(new Error('synthetic failure'));
  else vi.mocked(api.mihomo).mockImplementationOnce(async () => ({}));
  expect(await useApp.getState().toggleFixedNode('Main', 'B')).toBe(false);
  expect(fixed()).toBeUndefined();
});
it('取消固定只移除记录，不发出节点切换', async () => {
  await useApp.getState().toggleFixedNode('Main', 'B');
  vi.mocked(api.mihomo).mockClear();
  expect(await useApp.getState().toggleFixedNode('Main', 'B')).toBe(true);
  expect(fixed()).toBeUndefined(); expect(selected).toBe('B'); expect(puts()).toHaveLength(0);
});
it('手动切换别的节点清除固定，保守自动切换成功则转移固定', async () => {
  await useApp.getState().toggleFixedNode('Main', 'B');
  expect(await useApp.getState().selectNode('Main', 'C', getRoutingRevision())).toBe(true);
  expect(fixed()).toBe('C');
  expect(await useApp.getState().selectNode('Main', 'A')).toBe(true);
  expect(fixed()).toBeUndefined();
});
it('自动切换未确认不改变固定记录', async () => {
  await useApp.getState().toggleFixedNode('Main', 'B');
  vi.mocked(api.mihomo).mockRejectedValueOnce(new Error('synthetic failure'));
  expect(await useApp.getState().selectNode('Main', 'C', getRoutingRevision())).toBe(false);
  expect(fixed()).toBe('B');
});
it.each(['URLTest', 'Fallback', 'LoadBalance'])('%s组禁止旗标固定且不重启', async type => {
  useApp.setState(s => ({ groups: s.groups.map(g => ({ ...g, type })) }));
  expect(await useApp.getState().toggleFixedNode('Main', 'B')).toBe(false);
  expect(puts()).toHaveLength(0); expect(api.stopKernel).not.toHaveBeenCalled(); expect(api.startKernel).not.toHaveBeenCalled();
});
it.each(['URLTest', 'Fallback', 'LoadBalance', 'Relay', 'Unknown'])('%s组拒绝迟到的手选操作', async type => {
  useApp.setState(s => ({ groups: s.groups.map(g => ({ ...g, type })) }));
  expect(await useApp.getState().selectNode('Main', 'B')).toBe(false);
  expect(puts()).toHaveLength(0);
});
it('固定选择按活动订阅隔离，旧置顶不会迁成固定或发出选择', async () => {
  useApp.setState({ pinnedNodes: { Main: ['B'] } });
  expect(fixed()).toBeUndefined(); expect(puts()).toHaveLength(0);
  await useApp.getState().toggleFixedNode('Main', 'B');
  useApp.setState({ activeId: 'other', profiles: [profile, { ...profile, id: 'other' }] });
  await useApp.getState().toggleFixedNode('Main', 'C');
  expect(useApp.getState().fixedNodes).toEqual({ p: { Main: 'B' }, other: { Main: 'C' } });
});
it('固定请求在途中切换订阅或停止，迟到确认不能发布固定', async () => {
  let finish!: () => void;
  vi.mocked(api.mihomo).mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
  const pending = useApp.getState().toggleFixedNode('Main', 'B');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const stopping = useApp.getState().stopKernel(true);
  useApp.setState({ activeId: 'other' });
  finish(); await pending; await stopping;
  expect(useApp.getState().fixedNodes).toEqual({});
});
it('重连恢复当前订阅固定选择，确认在开启系统代理之前', async () => {
  useApp.setState({ kernelPhase: 'stopped', fixedNodes: { p: { Main: 'B' }, other: { Main: 'C' } } });
  await useApp.getState().startKernel(true);
  expect(selected).toBe('B'); expect(useApp.getState().kernelPhase).toBe('running');
  const putOrder = vi.mocked(api.mihomo).mock.invocationCallOrder[vi.mocked(api.mihomo).mock.calls.findIndex(([method]) => method === 'PUT')];
  expect(putOrder).toBeLessThan(vi.mocked(api.setSystemProxy).mock.invocationCallOrder[0]);
});
it('重连时已删除或不再支持的固定节点只清除失效记录，不发出选择', async () => {
  useApp.setState({ kernelPhase: 'stopped', fixedNodes: { p: { Main: 'deleted', Removed: 'B' } } });
  await useApp.getState().startKernel(true);
  expect(puts()).toHaveLength(0); expect(useApp.getState().fixedNodes.p).toEqual({});
});
it('重连恢复确认失败时不启系统代理，停止新启动内核', async () => {
  useApp.setState({ kernelPhase: 'stopped', fixedNodes: { p: { Main: 'B' } } });
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation((method, path, body) => method === 'PUT' ? Promise.reject(new Error('synthetic failure')) : original(method, path, body));
  await useApp.getState().startKernel(true);
  expect(api.setSystemProxy).not.toHaveBeenCalled(); expect(api.stopKernel).toHaveBeenCalledTimes(1);
  expect(useApp.getState().kernelPhase).toBe('failed');
});
it('恢复固定途中停止，排队停止收尾且不会开启系统代理', async () => {
  useApp.setState({ kernelPhase: 'stopped', fixedNodes: { p: { Main: 'B' } } });
  let finish!: () => void;
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation((method, path, body) => method === 'PUT' ? new Promise<void>(r => { finish = r; }) : original(method, path, body));
  const pending = useApp.getState().startKernel(true);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const stopping = useApp.getState().stopKernel(true);
  finish(); await pending; await stopping;
  expect(vi.mocked(api.setSystemProxy).mock.calls.filter(([on]) => on)).toHaveLength(0);
  expect(useApp.getState().kernelPhase).toBe('stopped');
});

it('水合旧收藏不会生成固定记录或在连接时发出节点选择', async () => {
  useApp.setState({ kernelPhase: 'stopped' });
  vi.mocked(api.loadAppState).mockResolvedValue(JSON.stringify({ activeId: 'p', profiles: [profile], pinnedNodes: { Main: ['B'] } }));
  vi.mocked(api.kernelStatus).mockResolvedValue({ running: false, pid: null });
  await useApp.getState().hydrate();
  expect(useApp.getState().fixedNodes).toEqual({});
  await useApp.getState().startKernel(true);
  expect(puts()).toHaveLength(0); expect(selected).toBe('A'); expect(api.startKernel).toHaveBeenCalledTimes(1);
});

it('水合只恢复显式且属于已有订阅的固定记录，重连确认后才启代理', async () => {
  useApp.setState({ kernelPhase: 'stopped' });
  vi.mocked(api.loadAppState).mockResolvedValue(JSON.stringify({ activeId: 'p', profiles: [profile],
    fixedNodes: { p: { Main: 'B', Broken: 8 }, removedProfile: { Main: 'C' } } }));
  vi.mocked(api.kernelStatus).mockResolvedValue({ running: false, pid: null });
  await useApp.getState().hydrate();
  expect(useApp.getState().fixedNodes).toEqual({ p: { Main: 'B' } });
  await useApp.getState().startKernel(true);
  expect(selected).toBe('B'); expect(fixed()).toBe('B');
});

it('启动读取分组期间取消固定，不发出迟到恢复选择', async () => {
  useApp.setState({ kernelPhase: 'stopped', fixedNodes: { p: { Main: 'B' } } });
  let finish!: () => void;
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementationOnce(async (method, path, body) => {
    await new Promise<void>(r => { finish = r; }); return original(method, path, body);
  });
  const pending = useApp.getState().startKernel(true);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(await useApp.getState().toggleFixedNode('Main', 'B')).toBe(true);
  finish(); await pending;
  expect(puts()).toHaveLength(0); expect(fixed()).toBeUndefined();
});

it('启动读取分组期间切换订阅，不恢复前一订阅或启系统代理', async () => {
  useApp.setState({ kernelPhase: 'stopped', fixedNodes: { p: { Main: 'B' } } });
  let finish!: () => void;
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementationOnce(async (method, path, body) => {
    await new Promise<void>(r => { finish = r; }); return original(method, path, body);
  });
  const pending = useApp.getState().startKernel(true);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  useApp.setState({ activeId: 'other', profiles: [profile, { ...profile, id: 'other' }] });
  finish(); await pending;
  expect(puts()).toHaveLength(0); expect(vi.mocked(api.setSystemProxy).mock.calls.filter(([on]) => on)).toHaveLength(0);
});

it('恢复一个固定分组时取消另一个固定，不再恢复被取消分组', async () => {
  useApp.setState({ kernelPhase: 'stopped', fixedNodes: { p: { Main: 'B', Second: 'C' } } });
  let finish!: () => void;
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (method === 'PUT') { await new Promise<void>(r => { finish = r; }); return original(method, path, body); }
    const result: any = await original(method, path, body);
    if (path === '/proxies') result.proxies.Second = { type: 'Selector', now: 'A', all: ['A', 'B', 'C'] };
    return result;
  });
  const pending = useApp.getState().startKernel(true);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await useApp.getState().toggleFixedNode('Second', 'C');
  finish(); await pending;
  expect(puts().map(([, path]) => path)).toEqual(['/proxies/Main']);
  expect(useApp.getState().fixedNodes.p.Second).toBeUndefined();
  expect(useApp.getState().kernelPhase).toBe('running');
});

it('复审：接管仍运行的内核时恢复固定后才补回系统代理', async () => {
  useApp.setState({ kernelPhase: 'stopped' });
  vi.mocked(api.loadAppState).mockResolvedValue(JSON.stringify({ activeId: 'p', profiles: [profile], sysProxyEnabled: true, fixedNodes: { p: { Main: 'B' } } }));
  vi.mocked(api.kernelStatus).mockResolvedValue({ running: true, pid: 123 });
  await useApp.getState().hydrate();
  expect(useApp.getState().fixedNodes.p.Main).toBe('B');
  expect(selected).toBe('B');
  expect(useApp.getState().groups[0].now).toBe('B');
});
it('复审：初始分组读取期间取消另一个固定不会使保留的固定恢复失败', async () => {
  useApp.setState({ kernelPhase: 'stopped', fixedNodes: { p: { Main: 'B', Second: 'C' } } });
  let finish!: () => void;
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementationOnce(async (method, path, body) => {
    await new Promise<void>(r => { finish = r; }); return original(method, path, body);
  });
  const pending = useApp.getState().startKernel(true);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await useApp.getState().toggleFixedNode('Second', 'C');
  finish(); await pending;
  expect(useApp.getState().kernelPhase).toBe('running');
  expect(fixed()).toBe('B'); expect(selected).toBe('B');
});
it('复审：固定恢复期间配置输入变化不能发布旧启动为已连接', async () => {
  useApp.setState({ kernelPhase: 'stopped', fixedNodes: { p: { Main: 'B' } } });
  let finish!: () => void;
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (method === 'PUT') await new Promise<void>(r => { finish = r; });
    return original(method, path, body);
  });
  const pending = useApp.getState().startKernel(true);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  useApp.getState().updateSettings({ mixedPort: 7891 });
  finish(); await pending;
  expect(useApp.getState().kernelPhase).not.toBe('running');
  expect(vi.mocked(api.setSystemProxy).mock.calls.filter(([on]) => on)).toHaveLength(0);
});

it('TUN启动读取的配置已固定节点，固定变化会使配置缓存失效', async () => {
  const raw = JSON.stringify({ proxies: ['A', 'B', 'C'].map(name => ({ name, type: 'socks5', server: '127.0.0.1', port: 1080 })),
    'proxy-groups': [{ name: 'Main', type: 'select', proxies: ['A', 'B', 'C'] }], rules: ['MATCH,Main'] });
  useApp.setState({ profiles: [{ ...profile, raw }], kernelPhase: 'stopped', tunEnabled: true, fixedNodes: { p: { Main: 'B' } } });
  let file: any;
  vi.mocked(api.prepareConfig).mockImplementation(async content => { file = JSON.parse(content); return '/isolated/candidate.yaml'; });
  const atStart: string[] = [];
  vi.mocked(api.startKernel).mockImplementation(async () => {
    expect(file.tun.enable).toBe(true);
    expect(file.profile['store-selected']).toBe(false);
    expect(file['proxy-groups'][0]['default-selected']).toBe(file['proxy-groups'][0].proxies[0]);
    selected = file['proxy-groups'][0].proxies[0]; atStart.push(selected);
    return { running: true, pid: 123 };
  });
  await useApp.getState().startKernel(true);
  expect(atStart).toEqual(['B']); expect(puts()).toHaveLength(0);
  await useApp.getState().toggleFixedNode('Main', 'C');
  await useApp.getState().stopKernel(true);
  await useApp.getState().startKernel(true);
  expect(atStart).toEqual(['B', 'C']); expect(api.prepareConfig).toHaveBeenCalledTimes(2);
});

it('复审：恢复确认GET期间取消其它分组不应停止连接', async () => {
  useApp.setState({ kernelPhase: 'stopped', fixedNodes: { p: { Main: 'B', Second: 'C' } } });
  let finish!: () => void; let reads = 0;
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (path === '/proxies' && ++reads === 2) await new Promise<void>(r => { finish = r; });
    const result: any = await original(method, path, body);
    if (path === '/proxies') result.proxies.Second = { type: 'Selector', now: 'A', all: ['A', 'B', 'C'] };
    return result;
  });
  const pending = useApp.getState().startKernel(true);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await useApp.getState().toggleFixedNode('Second', 'C');
  finish(); await pending;
  expect(useApp.getState().kernelPhase).toBe('running');
  expect(selected).toBe('B'); expect(fixed()).toBe('B');
  expect(api.stopKernel).not.toHaveBeenCalled();
});
it('复审：水合恢复首次GET期间手动选择不能被旧恢复停机吞掉', async () => {
  useApp.setState({ kernelPhase: 'stopped' });
  vi.mocked(api.loadAppState).mockResolvedValue(JSON.stringify({ activeId: 'p', profiles: [profile], sysProxyEnabled: true, fixedNodes: { p: { Main: 'B' } } }));
  vi.mocked(api.kernelStatus).mockResolvedValue({ running: true, pid: 123 });
  let finish!: () => void;
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementationOnce(async (method, path, body) => {
    await new Promise<void>(r => { finish = r; }); return original(method, path, body);
  });
  const pending = useApp.getState().hydrate();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(useApp.getState().kernelPhase).toBe('starting');
  const choosing = useApp.getState().selectNode('Main', 'C');
  finish(); await pending; await choosing;
  expect(useApp.getState().kernelPhase).toBe('running');
  expect(selected).toBe('C'); expect(fixed()).toBeUndefined();
  expect(api.stopKernel).not.toHaveBeenCalled();
});
it('复审：接管时固定恢复确认GET期间用户手动选择应最后生效', async () => {
  useApp.setState({ kernelPhase: 'stopped' });
  vi.mocked(api.loadAppState).mockResolvedValue(JSON.stringify({ activeId: 'p', profiles: [profile], sysProxyEnabled: true, fixedNodes: { p: { Main: 'B' } } }));
  vi.mocked(api.kernelStatus).mockResolvedValue({ running: true, pid: 123 });
  let finish!: () => void; let reads = 0;
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (path === '/proxies' && ++reads === 2) await new Promise<void>(r => { finish = r; });
    return original(method, path, body);
  });
  const pending = useApp.getState().hydrate();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(useApp.getState().kernelPhase).toBe('starting');
  const choosing = useApp.getState().selectNode('Main', 'C');
  finish(); await pending; await choosing;
  expect(useApp.getState().kernelPhase).toBe('running');
  expect(selected).toBe('C'); expect(fixed()).toBeUndefined();
  expect(api.stopKernel).not.toHaveBeenCalled();
});

it.each([true, false])('水合固定恢复失败保留现存代理状态%s，不停止已有连接或新增接管', async proxyEnabled => {
  useApp.setState({ kernelPhase: 'stopped' });
  vi.mocked(api.loadAppState).mockResolvedValue(JSON.stringify({ activeId: 'p', profiles: [profile], sysProxyEnabled: true, fixedNodes: { p: { Main: 'B' } } }));
  vi.mocked(api.kernelStatus).mockResolvedValue({ running: true, pid: 123 });
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: proxyEnabled, port: 7890 });
  vi.mocked(api.mihomo).mockRejectedValue(new Error('synthetic controller failure'));
  await useApp.getState().hydrate();
  expect(api.stopKernel).not.toHaveBeenCalled();
  expect(api.setSystemProxy).not.toHaveBeenCalled();
  expect(useApp.getState().kernelPhase).toBe('running');
  expect(useApp.getState().sysProxyEnabled).toBe(proxyEnabled);
  expect(useApp.getState().kernelError).toContain('固定节点');
});

it.each(['URLTest', 'Selector'])('Selector的%s子组不能固定，但普通手动选择保持可用', async type => {
  useApp.setState(s => ({ groups: [...s.groups.map(g => ({ ...g, nodes: [...g.nodes, { name: 'Nested', type, delay: null }] })),
    { name: 'Nested', type, now: 'A', nodes: s.groups[0].nodes }] }));
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    const result: any = await original(method, path, body);
    if (path === '/proxies') {
      result.proxies.Main.all.push('Nested');
      result.proxies.Nested = { type, now: 'A', all: ['A', 'B', 'C'] };
    }
    return result;
  });
  expect(await useApp.getState().toggleFixedNode('Main', 'Nested')).toBe(false);
  expect(puts()).toHaveLength(0); expect(fixed()).toBeUndefined();
  expect(useApp.getState().toast?.text).toContain('展开对应分组后固定具体节点');
  expect(await useApp.getState().selectNode('Main', 'Nested')).toBe(true);
  expect(selected).toBe('Nested'); expect(fixed()).toBeUndefined();
});

it.each(['URLTest', 'Selector'])('水合旧固定引用%s子组时清除记录且不恢复选择', async type => {
  useApp.setState({ kernelPhase: 'stopped' });
  vi.mocked(api.loadAppState).mockResolvedValue(JSON.stringify({ activeId: 'p', profiles: [profile], fixedNodes: { p: { Main: 'Nested' } } }));
  vi.mocked(api.kernelStatus).mockResolvedValue({ running: true, pid: 123 });
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    const result: any = await original(method, path, body);
    if (path === '/proxies') {
      result.proxies.Main.all.push('Nested');
      result.proxies.Nested = { type, now: 'A', all: ['A', 'B', 'C'] };
    }
    return result;
  });
  await useApp.getState().hydrate();
  expect(fixed()).toBeUndefined(); expect(puts()).toHaveLength(0);
  expect(selected).toBe('A'); expect(api.stopKernel).not.toHaveBeenCalled();
});


it('普通手动选择经控制器确认后按订阅记忆，失败不发布记忆', async () => {
  expect(await useApp.getState().selectNode('Main', 'B')).toBe(true);
  expect(useApp.getState().selectedNodes).toEqual({ p: { Main: 'B' } });
  expect(JSON.parse(vi.mocked(api.saveAppState).mock.calls.at(-1)![0]).selectedNodes).toEqual({ p: { Main: 'B' } });
  vi.mocked(api.mihomo).mockRejectedValueOnce(new Error('selection failed'));
  expect(await useApp.getState().selectNode('Main', 'C')).toBe(false);
  expect(useApp.getState().selectedNodes.p.Main).toBe('B');
});

it('重新水合和启动恢复普通选择，恢复记录与固定策略分开', async () => {
  useApp.setState({kernelPhase:'stopped', connectedAt:null});
  vi.mocked(api.loadAppState).mockResolvedValue(JSON.stringify({activeId:'p',profiles:[profile],selectedNodes:{p:{Main:'B'},removed:{Main:'C'}}}));
  vi.mocked(api.kernelStatus).mockResolvedValue({running:false,pid:null});
  await useApp.getState().hydrate();
  expect(useApp.getState().selectedNodes).toEqual({p:{Main:'B'}});
  await useApp.getState().startKernel(true);
  expect(selected).toBe('B');
  expect(fixed()).toBeUndefined();
  expect(useApp.getState().kernelPhase).toBe('running');
});

it('记忆节点已移除时回退当前有效选择，不导致连接失败', async () => {
  useApp.setState({kernelPhase:'stopped', connectedAt:null, selectedNodes:{p:{Main:'gone'}}});
  await useApp.getState().startKernel(true);
  expect(selected).toBe('A');
  expect(useApp.getState().kernelPhase).toBe('running');
  expect(useApp.getState().selectedNodes.p.Main).toBeUndefined();
});

it('手选的迟到应答不会把旧节点记到新订阅', async () => {
  let finish!: () => void;
  vi.mocked(api.mihomo).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = useApp.getState().selectNode('Main', 'B');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  useApp.setState({ activeId: 'other', profiles: [profile, { ...profile, id: 'other' }] });
  finish();
  expect(await pending).toBe(false);
  expect(useApp.getState().selectedNodes).toEqual({});
});

it('重启优先恢复固定节点，不再用普通记忆覆盖', async () => {
  useApp.setState({ kernelPhase: 'stopped', connectedAt: null,
    selectedNodes: { p: { Main: 'B' } }, fixedNodes: { p: { Main: 'C' } } });
  await useApp.getState().startKernel(true);
  expect(selected).toBe('C');
  expect(puts().map(call => call[2])).toEqual([{ name: 'C' }]);
});

it('普通恢复失败保留可用连接及记忆', async () => {
  useApp.setState({ kernelPhase: 'stopped', connectedAt: null, selectedNodes: { p: { Main: 'B' } } });
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (method === 'PUT') throw new Error('selection unavailable');
    return original(method, path, body);
  });
  await useApp.getState().startKernel(true);
  expect(useApp.getState().kernelPhase).toBe('running');
  expect(useApp.getState().selectedNodes.p.Main).toBe('B');
  expect(selected).toBe('A');
});

it('恢复时已变为自动组，不用旧的手选记忆干预内核', async () => {
  useApp.setState({ kernelPhase: 'stopped', connectedAt: null, selectedNodes: { p: { Main: 'B' } } });
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    const result = await original(method, path, body) as { proxies?: Record<string, { type: string }> };
    if (path === '/proxies' && result.proxies) result.proxies.Main.type = 'URLTest';
    return result;
  });
  await useApp.getState().startKernel(true);
  expect(useApp.getState().kernelPhase).toBe('running');
  expect(useApp.getState().selectedNodes.p.Main).toBeUndefined();
  expect(puts()).toHaveLength(0);
});
