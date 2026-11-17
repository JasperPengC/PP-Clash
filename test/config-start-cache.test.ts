// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import * as generator from '../src/core/generator';
import { useApp, type AppSettings } from '../src/store/app';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});

let disk: Record<string, any>;
const candidates = new Map<string, Record<string, any>>();
const started: Array<{ fileTunEnabled: boolean; requestedTunEnabled: boolean }> = [];
beforeEach(() => {
  vi.clearAllMocks();
  disk = {}; candidates.clear(); started.length = 0;
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, kernelPhase: 'stopped', sysProxyEnabled: false, tunEnabled: true,
    configPath: '', dataDir: '/isolated', activeId: 'synthetic',
    profiles: [{ id: 'synthetic', name: 'fixture', url: '', raw: 'proxies: []\nproxy-groups: []\nrules: ["DOMAIN,fixture.test,DIRECT"]', updatedAt: 0, userinfo: null, updateIntervalHours: null }],
    refreshGroups: vi.fn(async () => true) });
  vi.spyOn(generator, 'generateConfig');
  vi.mocked(api.prepareConfig).mockImplementation(async content => {
    const path = `/isolated/candidate-${candidates.size}.yaml`;
    candidates.set(path, JSON.parse(content)); return path;
  });
  vi.mocked(api.commitConfig).mockImplementation(async path => { disk = candidates.get(path)!; return '/isolated/config.yaml'; });
  vi.mocked(api.validateConfig).mockResolvedValue(undefined);
  vi.mocked(api.finishConfig).mockResolvedValue(undefined);
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: false, port: 7890, host: '127.0.0.1' });
  vi.mocked(api.setSystemProxy).mockImplementation(async (enabled, host, port) => ({ enabled, host, port }));
  vi.mocked(api.startKernel).mockImplementation(async (_path, _dir, _kernel, elevated) => {
    started.push({ fileTunEnabled: disk.tun.enable, requestedTunEnabled: elevated });
    return { running: true, pid: 123 };
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('关闭TUN后的配置生成失败时，重新连接不能沿用TUN仍开启的旧文件', async () => {
  useApp.setState({ kernelPhase: 'running' });
  expect(await useApp.getState().applyConfig()).toBe(true);
  expect(disk.tun.enable).toBe(true);
  useApp.getState().updateSettings({ overrides: [{ id: 'invalid', name: 'synthetic', mode: 'yaml', enabled: true,
    text: 'external-controller: "0.0.0.0:19090"' }] });
  await useApp.getState().setTun(false);
  expect(useApp.getState().kernelPhase).toBe('stopped');
  expect(useApp.getState().tunEnabled).toBe(false);
  expect(useApp.getState().configPath).toBe('/isolated/config.yaml');
  await useApp.getState().startKernel(true);
  expect(started).toEqual([]);
});

it('相同输入和外观偏好复用已校验配置，外观变化不会隐式重启', async () => {
  expect(await useApp.getState().applyConfig()).toBe(true);
  useApp.getState().updateSettings({ theme: 'dark', textSize: 'large', traySpeed: false });
  expect(api.stopKernel).not.toHaveBeenCalled();
  expect(api.startKernel).not.toHaveBeenCalled();
  await useApp.getState().startKernel(true);
  useApp.getState().updateSettings({ theme: 'light', textSize: 'standard' });
  await useApp.getState().stopKernel(true);
  await useApp.getState().startKernel(true);
  expect(generator.generateConfig).toHaveBeenCalledTimes(1);
  expect(api.prepareConfig).toHaveBeenCalledTimes(1);
  expect(api.validateConfig).toHaveBeenCalledTimes(1);
  expect(api.startKernel).toHaveBeenCalledTimes(2);
});

const changes: Array<[string, () => void]> = [
  ...([
    ['mixedPort', { mixedPort: 7891 }], ['controller', { controllerPort: 9091, controllerSecret: 'synthetic-secret' }],
    ['mode', { mode: 'global' }], ['DNS', { dnsPort: 1054, dnsNameserver: 'custom', dnsCustom: 'https://resolver.test/dns-query' }],
    ['LAN', { allowLan: true, bindAddress: '0.0.0.0', authUser: 'fixture', authPass: 'synthetic' }],
    ['ports', { socksPort: 7892, httpPort: 7893, redirPort: 7894 }], ['geo', { geoAutoUpdate: true, geoUpdateInterval: 12 }],
    ['sniffer', { snifferEnabled: true, snifferOverrideDestination: true }],
    ['custom rules', { customRules: [{ id: 'c', type: 'DOMAIN', payload: 'custom.test', target: 'REJECT', enabled: true }] }],
    ['override', { overrides: [{ id: 'o', name: 'fixture', mode: 'yaml', enabled: true, text: 'log-level: debug' }] }],
    ['kernel', { kernelPath: '/isolated/other-kernel' }],
  ] satisfies Array<[string, Partial<AppSettings>]>).map(([name, patch]) => [name, () => useApp.getState().updateSettings(patch)] as [string, () => void]),
  ['TUN', () => useApp.setState({ tunEnabled: false })],
  ['policy', () => useApp.setState(s => ({ policy: { ...s.policy, blockQuic: true } }))],
  ['raw', () => useApp.setState(s => ({ profiles: s.profiles.map(p => ({ ...p, raw: p.raw + '\n# changed input' })) }))],
  ['ruleEdits', () => useApp.setState(s => ({ profiles: s.profiles.map(p => ({ ...p, ruleEdits: { order: [], edits: { 0: { enabled: false } } } })) }))],
  ['activeId', () => useApp.setState(s => ({ activeId: 'second', profiles: [...s.profiles, { ...s.profiles[0], id: 'second' }] }))],
];
it.each(changes)('%s变化后启动重新准备和校验当前输入', async (_name, change) => {
  expect(await useApp.getState().applyConfig()).toBe(true);
  change();
  await useApp.getState().startKernel(true);
  expect(generator.generateConfig).toHaveBeenCalledTimes(2);
  expect(api.prepareConfig).toHaveBeenCalledTimes(2);
  expect(api.validateConfig).toHaveBeenCalledTimes(2);
  expect(started).toEqual([{ fileTunEnabled: useApp.getState().tunEnabled, requestedTunEnabled: useApp.getState().tunEnabled }]);
  expect(disk['mixed-port']).toBe(useApp.getState().settings.mixedPort);
  expect(disk['external-controller']).toBe(`127.0.0.1:${useApp.getState().settings.controllerPort}`);
});

it.each(changes)('%s变化后校验失败不能回退到旧文件启动', async (_name, change) => {
  expect(await useApp.getState().applyConfig()).toBe(true);
  const previous = disk;
  change();
  vi.mocked(api.validateConfig).mockRejectedValue(new Error('synthetic invalid config'));
  await useApp.getState().startKernel(true);
  expect(api.startKernel).not.toHaveBeenCalled();
  expect(disk).toBe(previous);
  expect(useApp.getState().configPath).toBe('/isolated/config.yaml');
});

it('相同输入的重新准备失败也必须撤销旧配置的启动资格', async () => {
  expect(await useApp.getState().applyConfig()).toBe(true);
  vi.mocked(api.validateConfig).mockRejectedValue(new Error('synthetic invalid config'));
  expect(await useApp.getState().applyConfig()).toBe(false);
  await useApp.getState().startKernel(true);
  expect(api.startKernel).not.toHaveBeenCalled();
});

it('候选校验等待期间修改外观仍可完成准备并复用', async () => {
  let finish!: () => void;
  vi.mocked(api.validateConfig).mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
  const pending = useApp.getState().applyConfig();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  useApp.getState().updateSettings({ theme: 'dark', textSize: 'large' });
  finish();
  expect(await pending).toBe(true);
  await useApp.getState().startKernel(true);
  expect(api.prepareConfig).toHaveBeenCalledTimes(1);
  expect(api.validateConfig).toHaveBeenCalledTimes(1);
  expect(api.startKernel).toHaveBeenCalledTimes(1);
});

it('启动排队等待事务收尾时改变输入，不能以新参数启动旧文件', async () => {
  let finish!: () => void;
  vi.mocked(api.finishConfig).mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
  const preparing = useApp.getState().applyConfig();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const starting = useApp.getState().startKernel(true);
  useApp.getState().updateSettings({ controllerPort: 9091 });
  finish();
  expect(await preparing).toBe(false);
  await starting;
  expect(api.startKernel).not.toHaveBeenCalled();
});

it('无关订阅元数据与禁用覆写不使当前缓存失效', async () => {
  expect(await useApp.getState().applyConfig()).toBe(true);
  useApp.setState(s => ({ profiles: s.profiles.map(p => ({ ...p, name: 'renamed', updatedAt: 123 })) }));
  useApp.getState().updateSettings({ overrides: [{ id: 'off', name: 'disabled', enabled: false, mode: 'yaml', text: 'external-controller: 0.0.0.0:19090' }] });
  await useApp.getState().startKernel(true);
  expect(api.prepareConfig).toHaveBeenCalledTimes(1);
  expect(api.startKernel).toHaveBeenCalledTimes(1);
});

it('停止清空分组不会使同一输入的当前节点规则重新生成或退回DIRECT', async () => {
  vi.useFakeTimers();
  useApp.setState(s => ({ kernelPhase: 'running', groups: [{ name: 'Primary', type: 'Selector', now: 'REJECT', nodes: [] }],
    settings: { ...s.settings, customRules: [{ id: 'current', enabled: true, type: 'DOMAIN', payload: 'current.test', target: '__CURRENT__' }] } }));
  const restarting = useApp.getState().restartKernel(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(await restarting).toBe(true);
  expect(generator.generateConfig).toHaveBeenCalledTimes(1);
  expect(api.validateConfig).toHaveBeenCalledTimes(1);
  expect(disk.rules).toContain('DOMAIN,current.test,REJECT');
});

it('切换订阅后不能用上一订阅保存的当前节点解析占位符', async () => {
  useApp.setState(s => ({ groups: [{ name: 'Primary', type: 'Selector', now: 'REJECT', nodes: [] }],
    settings: { ...s.settings, overrides: [{ id: 'current', enabled: true, name: 'current', mode: 'yaml', text: 'rules: ["DOMAIN,current.test,{{CURRENT_NODE}}"]' }] } }));
  expect(await useApp.getState().applyConfig()).toBe(true);
  expect(disk.rules).toContain('DOMAIN,current.test,REJECT');
  useApp.setState(s => ({ activeId: 'second', groups: [], profiles: [...s.profiles, { ...s.profiles[0], id: 'second' }] }));
  await useApp.getState().startKernel(true);
  expect(api.prepareConfig).toHaveBeenCalledTimes(2);
  expect(disk.rules).toContain('DOMAIN,current.test,DIRECT');
});

it('系统代理连接入口也拒绝新输入校验失败后的旧缓存', async () => {
  useApp.setState({ tunEnabled: false });
  expect(await useApp.getState().applyConfig()).toBe(true);
  useApp.getState().updateSettings({ mixedPort: 7891 });
  vi.mocked(api.validateConfig).mockRejectedValue(new Error('synthetic invalid config'));
  await useApp.getState().toggleSystemProxy(true);
  expect(api.startKernel).not.toHaveBeenCalled();
  expect(api.setSystemProxy).not.toHaveBeenCalled();
});
