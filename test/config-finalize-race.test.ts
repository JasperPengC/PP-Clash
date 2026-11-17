// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';
vi.mock('../src/core/api', async original => {
  const actual = await original<any>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});
afterEach(() => vi.useRealTimers());
it('事务收尾期间新设置校验失败，旧规则续体不能重启旧配置并开启新端口代理', async () => {
  vi.useFakeTimers();
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, kernelPhase: 'running', sysProxyEnabled: false, tunEnabled: false,
    configPath: '/isolated/config.yaml', dataDir: '/isolated', activeId: 'p',
    profiles: [{ id: 'p', name: 'fixture', url: '', raw: 'proxies: []\nproxy-groups: []\nrules: []', updatedAt: 0, userinfo: null, updateIntervalHours: null }],
    refreshGroups: vi.fn(async () => true) });
  let diskPort = 7890;
  let sequence = 0;
  const candidates = new Map<string, number>();
  vi.mocked(api.prepareConfig).mockImplementation(async content => {
    const path = `/isolated/candidate-${++sequence}.yaml`; candidates.set(path, JSON.parse(content)['mixed-port']); return path;
  });
  vi.mocked(api.validateConfig).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('new config invalid'));
  vi.mocked(api.commitConfig).mockImplementation(async path => { diskPort = candidates.get(path)!; return '/isolated/config.yaml'; });
  let finish!: () => void;
  vi.mocked(api.finishConfig).mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
  vi.mocked(api.startKernel).mockResolvedValue({ running: true, pid: 123 });
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: false, port: 7890 });
  vi.mocked(api.setSystemProxy).mockImplementation(async (enabled, _host, port) => ({ enabled, port }));
  const editing = useApp.getState().updateRuleEdits({ order: [], edits: {} });
  await vi.advanceTimersByTimeAsync(0);
  expect(finish).toBeTypeOf('function');
  expect(api.finishConfig).toHaveBeenCalledWith('/isolated/candidate-1.yaml', false);
  useApp.getState().updateSettings({ mixedPort: 7891 });
  expect(await useApp.getState().applyConfig()).toBe(false);
  finish();
  await vi.advanceTimersByTimeAsync(400);
  await editing;
  expect({ diskPort, settingPort: useApp.getState().settings.mixedPort,
    startCalls: vi.mocked(api.startKernel).mock.calls.length,
    enabledProxyPorts: vi.mocked(api.setSystemProxy).mock.calls.filter(c => c[0]).map(c => c[2])
  }).toEqual({ diskPort: 7890, settingPort: 7891, startCalls: 0, enabledProxyPorts: [] });
});
