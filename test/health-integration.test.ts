// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp, getRoutingRevision } from '../src/store/app';
import { startBackgroundHealth } from '../src/application/background-health';
import { CHECK_INTERVAL } from '../src/core/failover';

vi.mock('../src/core/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});
let stop: (() => void) | undefined;
let selected: string;
const failed = { google: false, github: false, openai: true };
const healthy = { google: true, github: true, openai: true };
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); localStorage.clear(); selected = 'A';
  useApp.setState({ ...useApp.getInitialState(), kernelPhase: 'running', tunEnabled: true, connectedAt: 1,
    routing: { primary: 'Main', managed: ['Main'] },
    settings: { ...useApp.getInitialState().settings, autoFailover: true, egressGuard: false } });
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (method === 'PUT') { selected = (body as { name: string }).name; return {}; }
    if (path === '/proxies') return { proxies: { Main: { type: 'Selector', now: selected, all: ['A', 'B', 'C'] }, A: { type: 'Shadowsocks' }, B: { type: 'Shadowsocks' }, C: { type: 'Shadowsocks' } } };
    if (path === '/rules') return { rules: [{ type: 'Match', proxy: 'Main' }] };
    throw new Error(`unexpected ${method} ${path}`);
  });
  vi.mocked(api.probeNodeHealth).mockImplementation(async node => node === 'A' ? failed : healthy);
  await useApp.getState().refreshGroups();
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.clearAllMocks(); });
const rounds = async (count: number) => { await vi.advanceTimersByTimeAsync(count * CHECK_INTERVAL); };
const puts = () => vi.mocked(api.mihomo).mock.calls.filter(([method]) => method === 'PUT');

it('后台三轮故障验证备用后只切换一次，冷却能跨控制层重建保留', async () => {
  stop = startBackgroundHealth();
  expect(api.probeNodeHealth).not.toHaveBeenCalled();
  await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(puts()).toHaveLength(1); expect(selected).toBe('B');
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(4);
  stop(); stop = startBackgroundHealth();
  await rounds(4); expect(puts()).toHaveLength(1); expect(api.probeNodeHealth).toHaveBeenCalledTimes(4);
});

it('控制器读取失败清空失败计数，绝不利用旧分组切换', async () => {
  stop = startBackgroundHealth(); await rounds(2);
  vi.mocked(api.mihomo).mockRejectedValueOnce(new Error('controller offline'));
  await rounds(1); await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(puts()).toHaveLength(1);
});

it('关闭后立即重新启用也不会沿用旧失败轮次', async () => {
  stop = startBackgroundHealth(); await rounds(2);
  useApp.getState().updateSettings({ autoFailover: false });
  useApp.getState().updateSettings({ autoFailover: true });
  await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(puts()).toHaveLength(1);
});

it('睡眠恢复跳过当前轮，重新等待网络稳定再累计', async () => {
  stop = startBackgroundHealth(); await rounds(2);
  vi.setSystemTime(Date.now() + 3_600_000);
  await rounds(1); expect(api.probeNodeHealth).toHaveBeenCalledTimes(2);
  await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(puts()).toHaveLength(1);
});

it('候选检测期间手动选择其他节点，旧结果不能反向覆盖', async () => {
  let finish!: (value: typeof healthy) => void;
  vi.mocked(api.probeNodeHealth).mockImplementation(node => node === 'A' ? Promise.resolve(failed) : new Promise(r => { finish = r; }));
  stop = startBackgroundHealth(); await rounds(3);
  await useApp.getState().selectNode('Main', 'C');
  finish(healthy); await vi.advanceTimersByTimeAsync(0);
  expect(selected).toBe('C'); expect(puts()).toHaveLength(1);
});

it('排队的自动选择遇到用户新操作时取消，并保留最后手动选择', async () => {
  const revision = getRoutingRevision();
  const automatic = useApp.getState().selectNode('Main', 'B', revision);
  const manual = useApp.getState().selectNode('Main', 'C');
  expect(await automatic).toBe(false); expect(await manual).toBe(true);
  expect(selected).toBe('C'); expect(puts()).toHaveLength(1);
});

it('刷新仅更新读到的分组，不写配置或重启；接管现有内核使用实际 MATCH', async () => {
  useApp.setState({ routing: null });
  expect(await useApp.getState().refreshGroups()).toBe(true);
  expect(useApp.getState().routing?.primary).toBe('Main');
  expect(api.saveConfig).not.toHaveBeenCalled(); expect(api.stopKernel).not.toHaveBeenCalled();
  expect(api.startKernel).not.toHaveBeenCalled(); expect(puts()).toHaveLength(0);
});

it('重启在停机之前准备并校验配置，停机后不再次生成', async () => {
  const generated = vi.fn(useApp.getState().applyConfig);
  useApp.setState({ applyConfig: generated, activeId: 'synthetic',
    profiles: [{ id: 'synthetic', name: 'fixture', url: '', raw: 'proxies: []\nproxy-groups: []\nrules: []', updatedAt: 0, userinfo: null, updateIntervalHours: null }] });
  vi.mocked(api.prepareConfig).mockResolvedValue('/isolated/candidate.yaml');
  vi.mocked(api.commitConfig).mockResolvedValue('/isolated/validated.yaml');
  vi.mocked(api.startKernel).mockResolvedValue({ running: true, pid: 123 });
  const pending = useApp.getState().restartKernel(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toBe(true);
  expect(generated).toHaveBeenCalledTimes(1);
  expect(api.validateConfig).toHaveBeenCalledTimes(1);
  expect(api.startKernel).toHaveBeenCalledWith('/isolated/validated.yaml', '/isolated', null, true, 9090, '');
  expect(vi.mocked(api.validateConfig).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.stopKernel).mock.invocationCallOrder[0]);
});

it('准备配置失败保持原内核，保存出口策略不会隐式重启', async () => {
  useApp.setState({ applyConfig: vi.fn(async () => false) });
  expect(await useApp.getState().restartKernel(true)).toBe(false);
  expect(api.stopKernel).not.toHaveBeenCalled();
  useApp.getState().updateSettings({ stableRouting: false });
  expect(useApp.getState().configPath).toBe('');
  expect(api.startKernel).not.toHaveBeenCalled();
});

it('固定节点连续故障后验证备用并转移固定，原节点恢复不自动跳回', async () => {
  useApp.setState({ activeId: 'fixed-profile', fixedNodes: { 'fixed-profile': { Main: 'A' } } });
  stop = startBackgroundHealth();
  await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(selected).toBe('B');
  expect(useApp.getState().fixedNodes['fixed-profile'].Main).toBe('B');
  vi.mocked(api.probeNodeHealth).mockResolvedValue(healthy);
  await rounds(30);
  expect(selected).toBe('B'); expect(puts()).toHaveLength(1);
  expect(useApp.getState().fixedNodes['fixed-profile'].Main).toBe('B');
});
