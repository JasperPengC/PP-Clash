// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';

vi.mock('../src/core/platform', () => ({ isAndroid: true, isWindows: false, isLinux: false }));
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});

const initial = useApp.getInitialState();
beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ ...initial, kernelPhase: 'running', tunEnabled: true, connectedAt: 42,
    activeId: 'one', runtimeConfigRevision: 1, persistenceFrozen: true,
    groups: [{ name: 'Route', type: 'Selector', now: 'Tokyo', nodes: [{ name: 'Tokyo', type: 'Trojan', delay: 40 }] }] });
});
afterEach(() => useApp.setState(initial));

it('系统撤销 VPN 后清除连接状态，不调用桌面代理或再次启动 VPN', async () => {
  vi.mocked(api.kernelStatus).mockResolvedValue({ running: false, pid: null });
  expect(await useApp.getState().syncAndroidVpn(() => true)).toBe(true);
  expect(useApp.getState()).toMatchObject({ kernelPhase: 'stopped', tunEnabled: false, connectedAt: null, groups: [] });
  expect(api.startKernel).not.toHaveBeenCalled();
  expect(api.setSystemProxy).not.toHaveBeenCalled();
});

it('读状态失败时保留最后确认的 VPN 连接', async () => {
  vi.mocked(api.kernelStatus).mockRejectedValue(new Error('bridge unavailable'));
  expect(await useApp.getState().syncAndroidVpn(() => true)).toBe(false);
  expect(useApp.getState()).toMatchObject({ kernelPhase: 'running', tunEnabled: true, connectedAt: 42 });
});

it('页面进入后台后忽略在途状态检查', async () => {
  vi.mocked(api.kernelStatus).mockResolvedValue({ running: false, pid: null });
  expect(await useApp.getState().syncAndroidVpn(() => false)).toBe(false);
  expect(useApp.getState().kernelPhase).toBe('running');
});

it.each(['profile', 'revision', 'controller'] as const)('切换 %s 后旧断开结果不能清掉新的会话', async change => {
  let finish!: (value: { running: boolean; pid: null }) => void;
  vi.mocked(api.kernelStatus).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const checking = useApp.getState().syncAndroidVpn(() => true);
  if (change === 'profile') useApp.setState({ activeId: 'two' });
  if (change === 'revision') useApp.setState({ runtimeConfigRevision: 2 });
  if (change === 'controller') useApp.setState({ settings: { ...useApp.getState().settings, controllerPort: 9091 } });
  finish({ running: false, pid: null });
  expect(await checking).toBe(false);
  expect(useApp.getState()).toMatchObject({ kernelPhase: 'running', tunEnabled: true, connectedAt: 42 });
  expect(useApp.getState().groups).toHaveLength(1);
});

it('配置正在切换时不执行 VPN 状态检查', async () => {
  useApp.setState({ runtimeConfigTransition: true });
  expect(await useApp.getState().syncAndroidVpn(() => true)).toBe(false);
  expect(api.kernelStatus).not.toHaveBeenCalled();
});
