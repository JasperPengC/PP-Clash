// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { getLifecycleToken, useApp } from '../src/store/app';
vi.mock('../src/core/api', async original => {
  const actual = await original<any>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});
let proxy = { enabled: true, port: 7890 };
const raw = 'proxies: []\nproxy-groups: []\nrules: []';
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, kernelPhase: 'running', tunEnabled: false, sysProxyEnabled: true, connectedAt: 1,
    activeId: 'p', profiles: [{ id: 'p', name: 'mock', url: '', raw, updatedAt: 0, userinfo: null, updateIntervalHours: null }],
    configPath: '/isolated/config.yaml', dataDir: '/isolated',
    applyConfig: vi.fn(async () => true), refreshGroups: vi.fn(async () => true) });
  proxy = { enabled: true, port: 7890 };
  vi.mocked(api.startKernel).mockResolvedValue({ running: true, pid: 123 });
  vi.mocked(api.getSystemProxy).mockImplementation(async () => ({ ...proxy }));
  vi.mocked(api.setSystemProxy).mockImplementation(async (on, _host, port) => { proxy = { enabled: on, port }; return { ...proxy }; });
  vi.mocked(api.validateConfig).mockResolvedValue(undefined);
  vi.mocked(api.stopKernel).mockResolvedValue({ running: false, pid: null });
  vi.mocked(api.saveAppState).mockResolvedValue(undefined);
  vi.mocked(api.discardConfig).mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });
it('端口更新排队后立即断开应撤销原端口系统代理', async () => {
  useApp.getState().updateSettings({ mixedPort: 7891 });
  await useApp.getState().disconnect();
  expect(useApp.getState().kernelPhase).toBe('stopped');
  expect(proxy.enabled).toBe(false);
});
it('规则保存等待配置时断开应取消随后重启', async () => {
  let finish!: (value: boolean) => void;
  useApp.setState({ applyConfig: vi.fn().mockImplementationOnce(() => new Promise(r => { finish = r; })).mockResolvedValue(true) });
  const editing = useApp.getState().updateRuleEdits({} as any);
  expect(finish).toBeTypeOf('function');
  await useApp.getState().disconnect();
  finish(true);
  await vi.advanceTimersByTimeAsync(400);
  await editing;
  expect(api.startKernel).not.toHaveBeenCalled();
  expect(useApp.getState().kernelPhase).toBe('stopped');
  expect(proxy.enabled).toBe(false);
});
it('TUN候选配置失败应恢复原接管状态', async () => {
  useApp.setState({ applyConfig: vi.fn(async () => false) });
  await useApp.getState().setTun(true);
  expect(api.startKernel).not.toHaveBeenCalled();
  expect(api.stopKernel).not.toHaveBeenCalled();
  expect(useApp.getState().tunEnabled).toBe(false);
});

it('断开不会撤销后来被其它客户端改到未知端口的代理', async () => {
  useApp.getState().updateSettings({ mixedPort: 7891 });
  proxy = { enabled: true, port: 8888 };
  await useApp.getState().disconnect();
  expect(proxy).toEqual({ enabled: true, port: 8888 });
  expect(api.setSystemProxy).not.toHaveBeenCalled();
});

it('TUN准备失败恢复的状态会持久化，过期失败不覆盖新意图', async () => {
  useApp.setState({ applyConfig: vi.fn(async () => false) });
  await useApp.getState().setTun(true);
  const saved = JSON.parse(vi.mocked(api.saveAppState).mock.calls.at(-1)![0]);
  expect(saved.tunEnabled).toBe(false);
  expect(saved.sysProxyEnabled).toBe(true);
  let finish!: (value: boolean) => void;
  useApp.setState({ applyConfig: vi.fn().mockImplementationOnce(() => new Promise(r => { finish = r; })).mockResolvedValue(true) });
  const old = useApp.getState().setTun(true);
  await useApp.getState().disconnect();
  finish(false); await old;
  expect(useApp.getState().tunEnabled).toBe(false);
  expect(useApp.getState().sysProxyEnabled).toBe(false);
  expect(api.startKernel).not.toHaveBeenCalled();
});

it('页面传入旧代次调用重启不会重新获得接管权', async () => {
  const token = getLifecycleToken();
  await useApp.getState().disconnect();
  expect(await useApp.getState().restartKernel(true, token, true)).toBe(false);
  expect(api.startKernel).not.toHaveBeenCalled();
  expect(proxy.enabled).toBe(false);
});
