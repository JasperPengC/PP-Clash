// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});
beforeEach(async () => {
  vi.useFakeTimers();
  useApp.setState({ ...useApp.getInitialState(), kernelPhase: 'running', tunEnabled: true, connectedAt: 1,
    configPath: '', dataDir: '/isolated', activeId: 'synthetic',
    profiles: [{ id: 'synthetic', name: 'fixture', url: '', raw: 'proxies: []\nproxy-groups: []\nrules: []', updatedAt: 0, userinfo: null, updateIntervalHours: null }],
    refreshGroups: vi.fn(async () => true) });
  vi.mocked(api.prepareConfig).mockResolvedValue('/isolated/candidate.yaml');
  vi.mocked(api.commitConfig).mockResolvedValue('/isolated/config.yaml');
  vi.mocked(api.startKernel).mockResolvedValue({ running: true, pid: 123 });
  vi.mocked(api.setSystemProxy).mockImplementation(async on => ({ enabled: on }));
  expect(await useApp.getState().applyConfig()).toBe(true);
  vi.clearAllMocks();
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it('关闭连接取消等待中的重启', async () => {
  const pending = useApp.getState().restartKernel(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(useApp.getState().kernelPhase).toBe('stopped');
  await useApp.getState().disconnect();
  const callsAtDisconnect = vi.mocked(api.startKernel).mock.calls.length;
  await vi.advanceTimersByTimeAsync(400);
  await pending;
  expect(api.startKernel).toHaveBeenCalledTimes(callsAtDisconnect);
  expect(useApp.getState().kernelPhase).toBe('stopped');
  expect(useApp.getState().sysProxyEnabled).toBe(false);
});
it('关闭连接取消端口冲突延迟重试', async () => {
  useApp.setState({ kernelPhase: 'stopped' });
  vi.mocked(api.startKernel).mockRejectedValueOnce(new Error('address already in use'));
  await useApp.getState().startKernel(true);
  expect(useApp.getState().kernelPhase).toBe('failed');
  await useApp.getState().disconnect();
  await vi.advanceTimersByTimeAsync(1200);
  expect(api.startKernel).toHaveBeenCalledTimes(1);
  expect(useApp.getState().kernelPhase).toBe('stopped');
  expect(useApp.getState().sysProxyEnabled).toBe(false);
});
it('配置准备期间关闭连接取消自动恢复', async () => {
  let finish!: (value: boolean) => void;
  useApp.setState({ applyConfig: vi.fn().mockImplementationOnce(() => new Promise(r => finish = r)).mockResolvedValue(true) });
  const pending = useApp.getState().handleKernelLost();
  await vi.advanceTimersByTimeAsync(800);
  expect(finish).toBeTypeOf('function');
  await useApp.getState().disconnect();
  finish(true);
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  expect(api.startKernel).not.toHaveBeenCalled();
  expect(useApp.getState().kernelPhase).toBe('stopped');
  expect(useApp.getState().sysProxyEnabled).toBe(false);
});

it('重启等待期间关闭TUN不会随后开启系统代理', async () => {
  const pending = useApp.getState().restartKernel(true);
  await vi.advanceTimersByTimeAsync(0);
  await useApp.getState().setTun(false);
  expect(useApp.getState().tunEnabled).toBe(false);
  expect(useApp.getState().kernelPhase).toBe('stopped');
  await vi.advanceTimersByTimeAsync(400);
  await pending;
  expect(useApp.getState().kernelPhase).toBe('stopped');
  expect(useApp.getState().sysProxyEnabled).toBe(false);
});

it('已发出的启动完成后才执行停止，关闭不会被迟到成功重新开启代理', async () => {
  useApp.setState({ kernelPhase: 'stopped', tunEnabled: false });
  let finish!: (value: { running: boolean; pid: number }) => void;
  vi.mocked(api.startKernel).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const starting = useApp.getState().startKernel(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(finish).toBeTypeOf('function');
  const closing = useApp.getState().disconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(api.stopKernel).not.toHaveBeenCalled();
  finish({ running: true, pid: 123 });
  await starting; await closing;
  expect(api.stopKernel).toHaveBeenCalledTimes(1);
  expect(api.setSystemProxy).not.toHaveBeenCalledWith(true, expect.anything(), expect.anything());
  expect(useApp.getState().kernelPhase).toBe('stopped');
  expect(useApp.getState().sysProxyEnabled).toBe(false);
});

it('系统代理开启仍在途时关闭，串行撤销迟到的代理开启', async () => {
  useApp.setState({ kernelPhase: 'stopped', tunEnabled: false });
  let enabled = false;
  let finish!: () => void;
  vi.mocked(api.getSystemProxy).mockImplementation(async () => ({ enabled, port: 7890 }));
  vi.mocked(api.setSystemProxy).mockImplementation(async on => {
    if (on) await new Promise<void>(r => { finish = r; });
    enabled = on; return { enabled };
  });
  const starting = useApp.getState().startKernel(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(finish).toBeTypeOf('function');
  const closing = useApp.getState().disconnect();
  finish(); await starting; await closing;
  expect(enabled).toBe(false);
  expect(useApp.getState().sysProxyEnabled).toBe(false);
  expect(useApp.getState().kernelPhase).toBe('stopped');
});

it('启动恢复计时器在用户关闭后失效', async () => {
  vi.mocked(api.loadAppState).mockResolvedValueOnce(JSON.stringify({ activeId: 'saved', tunEnabled: true,
    profiles: [{ id: 'saved', name: 'fixture', url: '', raw: 'proxies: []', userinfo: { total: 100, upload: 0, download: 0 }, updatedAt: Date.now() }] }));
  vi.mocked(api.kernelStatus).mockResolvedValueOnce({ running: false, pid: null });
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: false, port: 7890 });
  await useApp.getState().hydrate();
  await useApp.getState().disconnect();
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.startKernel).not.toHaveBeenCalled();
  expect(useApp.getState().sysProxyEnabled).toBe(false);
  expect(useApp.getState().kernelPhase).toBe('stopped');
});

it('启动时控制器状态未知不清理内核或重连', async () => {
  vi.mocked(api.loadAppState).mockResolvedValueOnce(JSON.stringify({ sysProxyEnabled: true }));
  vi.mocked(api.kernelStatus).mockRejectedValueOnce(new Error('controller unknown'));
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: true, port: 7890 });
  await useApp.getState().hydrate();
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.cleanupStaleKernel).not.toHaveBeenCalled();
  expect(api.startKernel).not.toHaveBeenCalled();
  expect(api.setSystemProxy).not.toHaveBeenCalled();
});
