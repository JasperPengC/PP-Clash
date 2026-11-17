// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { generateConfig } from '../src/core/generator';
import { useApp, type Profile } from '../src/store/app';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});

const rawFor = (name: string) => JSON.stringify({
  proxies: [{ name, type: 'socks5', server: 'fixture.invalid', port: 1080 }],
  'proxy-groups': [{ name: 'Main', type: 'select', proxies: [name] }], rules: ['MATCH,Main'],
});
const oldRaw = rawFor('old-node');
const newRaw = rawFor('new-node');
const profile = (id = 'active'): Profile => ({ id, name: '旧名称', url: `https://${id}.invalid/sub`, raw: oldRaw,
  updatedAt: 123, userinfo: { upload: 1, download: 2, total: 10, expire: 0 }, updateIntervalHours: 24 });
const payload = (raw = newRaw) => ({ raw, profileTitle: '候选名称', contentDisposition: null,
  subscriptionUserinfo: 'upload=3; download=4; total=20; expire=42', profileUpdateInterval: '12' });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
const current = (id = 'active') => useApp.getState().profiles.find(p => p.id === id);
let disk: string;
let loaded: string;
let sequence: number;
const candidates = new Map<string, string>();
const previous = new Map<string, string>();
const nodeIn = (text: string) => JSON.parse(text).proxies?.[0]?.name;

it('活动订阅热更新成功后同步新的小面板策略顺序', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55 });
  const candidate = JSON.parse(newRaw);
  candidate['proxy-groups'] = [
    { name: 'Second', type: 'select', proxies: ['new-node'] },
    { name: 'Main', type: 'select', proxies: ['new-node'] },
  ];
  vi.mocked(api.fetchSubscription).mockResolvedValue(payload(JSON.stringify(candidate)));
  const original = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation((method, path, ...args) => path === '/proxies' ? Promise.resolve({ proxies: {
    Main: { type: 'Selector', all: ['new-node'], now: 'new-node' },
    Second: { type: 'Selector', all: ['new-node'], now: 'new-node' },
    'new-node': { type: 'Socks5' },
  } }) : original(method, path, ...args));
  expect(await useApp.getState().refreshProfile('active')).toBe(true);
  expect(api.setTrayFlags).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), ['Second', 'Main']);
});

beforeEach(async () => {
  vi.resetAllMocks(); candidates.clear(); previous.clear(); sequence = 0;
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, activeId: 'active', profiles: [profile(), profile('inactive')],
    configPath: '/isolated/config.yaml', dataDir: '/isolated', notify: vi.fn(),
    settings: { ...initial.settings, egressGuard: false },
    refreshGroups: vi.fn(async () => true) });
  disk = (await generateConfig(oldRaw, initial.policy)).config;
  loaded = disk;
  vi.mocked(api.fetchSubscription).mockResolvedValue(payload());
  vi.mocked(api.saveAppState).mockResolvedValue(undefined);
  vi.mocked(api.prepareConfig).mockImplementation(async content => {
    const path = `/isolated/candidate-${++sequence}.yaml`;
    candidates.set(path, content); return path;
  });
  vi.mocked(api.validateConfig).mockResolvedValue(undefined);
  vi.mocked(api.commitConfig).mockImplementation(async path => {
    previous.set(path, disk); disk = candidates.get(path)!; return '/isolated/config.yaml';
  });
  vi.mocked(api.finishConfig).mockImplementation(async (path, rollback) => {
    if (rollback) disk = previous.get(path)!;
  });
  vi.mocked(api.discardConfig).mockResolvedValue(undefined);
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: false, port: 7890 });
  vi.mocked(api.setSystemProxy).mockImplementation(async (enabled, _host, port) => ({ enabled, port }));
  vi.mocked(api.startKernel).mockImplementation(async () => { loaded = disk; return { running: true, pid: 123 }; });
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => {
    if (path.startsWith('/configs')) { loaded = disk; return null; }
    return { proxies: { Main: { type: 'Selector', now: nodeIn(loaded), all: [nodeIn(loaded)] },
      [nodeIn(loaded)]: { type: 'Socks5' } } };
  });
});

it('系统代理切换到 TUN 再切回后，订阅热更新仍能确认运行配置', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55, sysProxyEnabled: true, tunEnabled: false, elevated: true });
  await useApp.getState().setTun(true);
  expect(useApp.getState()).toMatchObject({ kernelPhase: 'running', tunEnabled: true, sysProxyEnabled: false, kernelError: null });
  expect(JSON.parse(loaded).tun.enable).toBe(true);
  await useApp.getState().setTun(false);
  await useApp.getState().toggleSystemProxy(true);
  expect(useApp.getState()).toMatchObject({ kernelPhase: 'running', tunEnabled: false, sysProxyEnabled: true, kernelError: null });
  expect(JSON.parse(loaded).tun.enable).toBe(false);
  expect(await useApp.getState().refreshProfile('active')).toBe(true);
  expect(current()!.raw).toBe(newRaw);
  expect(nodeIn(loaded)).toBe('new-node');
  expect(useApp.getState().kernelError).toBeNull();
  expect(useApp.getState().profileRefreshErrors.active).toBeUndefined();
});

it.each(['', '<html>login required</html>', 'proxies: [', '- not-a-config', 'mixed-port: 7890',
  'proxies: invalid', 'proxies: []\nproxy-groups: []\nrules: []', 'proxies: [{ name: broken }]'])
('无效候选 %j 不替换非活动订阅最后成功的内容与元信息', async raw => {
  const before = current('inactive'); const originalDisk = disk;
  vi.mocked(api.fetchSubscription).mockResolvedValue(payload(raw));
  expect(await useApp.getState().refreshProfile('inactive')).toBe(false);
  expect(current('inactive')).toEqual(before);
  expect(disk).toBe(originalDisk);
  expect(useApp.getState().notify).toHaveBeenCalledWith('error', expect.stringContaining('保留'));
  expect(useApp.getState().refreshingIds).toEqual([]);
});

it('有效非活动订阅也生成并校验候选，但不替换活动配置或运行观测', async () => {
  const originalDisk = disk; const stats = { proxyCount: 7 } as any;
  useApp.setState({ kernelPhase: 'running', connectedAt: 55, stats });
  expect(await useApp.getState().refreshProfile('inactive')).toBe(true);
  expect(api.validateConfig).toHaveBeenCalledOnce();
  expect(current('inactive')).toMatchObject({ raw: newRaw, name: '候选名称', userinfo: { upload: 3, download: 4, total: 20, expire: 42 }, updateIntervalHours: 12 });
  expect(current('inactive')!.updatedAt).toBeGreaterThan(123);
  expect(disk).toBe(originalDisk); expect(loaded).toBe(originalDisk);
  expect(useApp.getState().stats).toBe(stats);
  expect(api.commitConfig).not.toHaveBeenCalled();
  expect(api.stopKernel).not.toHaveBeenCalled();
});

it('不同订阅可同时更新，同一订阅去重，失败与成功各自清理更新状态', async () => {
  const first = deferred<ReturnType<typeof payload>>();
  const second = deferred<ReturnType<typeof payload>>();
  vi.mocked(api.fetchSubscription).mockImplementation(url => url.includes('inactive') ? second.promise : first.promise);
  const updating = useApp.getState().refreshProfile('active');
  const duplicate = useApp.getState().refreshProfile('active');
  const other = useApp.getState().refreshProfile('inactive');
  expect(duplicate).toBe(updating);
  expect(useApp.getState().refreshingIds).toEqual(['active', 'inactive']);
  first.resolve(payload('invalid subscription'));
  expect(await updating).toBe(false);
  expect(useApp.getState().refreshingIds).toEqual(['inactive']);
  expect(current()!.raw).toBe(oldRaw);
  second.resolve(payload());
  expect(await other).toBe(true);
  expect(useApp.getState().refreshingIds).toEqual([]);
  expect(current('inactive')!.raw).toBe(newRaw);
  expect(useApp.getState().profileRefreshErrors.active).toBeTruthy();
  expect(useApp.getState().profileRefreshErrors.inactive).toBeUndefined();
});

it.each(['download', 'generate', 'validate', 'commit'])('%s 失败保持原订阅、时间、元信息与运行配置', async stage => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55 });
  const before = current(); const originalDisk = disk;
  if (stage === 'download') vi.mocked(api.fetchSubscription).mockRejectedValueOnce(new Error('fixture download rejected'));
  if (stage === 'generate') useApp.getState().updateSettings({ overrides: [{ id: 'o', name: 'fixture', enabled: true, mode: 'yaml', text: 'external-controller: 0.0.0.0:1234' }] });
  if (stage === 'validate') vi.mocked(api.validateConfig).mockRejectedValueOnce(new Error('fixture validation rejected'));
  if (stage === 'commit') vi.mocked(api.commitConfig).mockRejectedValueOnce(new Error('fixture commit rejected'));
  expect(await useApp.getState().refreshProfile('active')).toBe(false);
  expect(current()).toEqual(before); expect(disk).toBe(originalDisk); expect(loaded).toBe(originalDisk);
  expect(api.stopKernel).not.toHaveBeenCalled();
  expect(useApp.getState().notify).not.toHaveBeenCalledWith('success', expect.anything());
  expect(useApp.getState().refreshingIds).toEqual([]);
});

it('活动候选加载被拒绝时回退磁盘，旧订阅与已连接内核继续使用旧内容', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55 });
  const before = current(); const originalDisk = disk;
  vi.mocked(api.mihomo).mockRejectedValueOnce(new Error('fixture load rejected'));
  expect(await useApp.getState().refreshProfile('active')).toBe(false);
  expect(current()).toEqual(before); expect(disk).toBe(originalDisk); expect(loaded).toBe(originalDisk);
  expect(useApp.getState().kernelPhase).toBe('running'); expect(useApp.getState().connectedAt).toBe(55);
  expect(api.stopKernel).not.toHaveBeenCalled(); expect(api.startKernel).not.toHaveBeenCalled();
  expect(useApp.getState().notify).not.toHaveBeenCalledWith('success', expect.anything());
});

it('活动候选在校验、正式提交和内核确认前保持原文，确认后一起发布', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55 });
  const before = current(); const validation = deferred<void>(); const commit = deferred<void>(); const load = deferred<void>();
  vi.mocked(api.validateConfig).mockImplementationOnce(() => validation.promise);
  vi.mocked(api.commitConfig).mockImplementationOnce(async path => {
    await commit.promise; previous.set(path, disk); disk = candidates.get(path)!; return '/isolated/config.yaml';
  });
  vi.mocked(api.mihomo).mockImplementationOnce(async () => { await load.promise; loaded = disk; return null; });
  const pending = useApp.getState().refreshProfile('active');
  await vi.waitFor(() => expect(api.validateConfig).toHaveBeenCalledOnce());
  expect(current()).toBe(before); validation.resolve();
  await vi.waitFor(() => expect(api.commitConfig).toHaveBeenCalledOnce());
  expect(current()).toBe(before); commit.resolve();
  await vi.waitFor(() => expect(api.mihomo).toHaveBeenCalledOnce());
  expect(current()).toBe(before); load.resolve();
  expect(await pending).toBe(true);
  expect(current()).toMatchObject({ raw: newRaw, name: '候选名称', updateIntervalHours: 12 });
  expect(nodeIn(disk)).toBe('new-node'); expect(nodeIn(loaded)).toBe('new-node');
  expect(useApp.getState().kernelPhase).toBe('running'); expect(useApp.getState().connectedAt).toBe(55);
});

it('同订阅并发刷新只下载和提交一次，调用方共享结果', async () => {
  const download = deferred<ReturnType<typeof payload>>();
  vi.mocked(api.fetchSubscription).mockImplementationOnce(() => download.promise);
  const first = useApp.getState().refreshProfile('active');
  const second = useApp.getState().refreshProfile('active');
  download.resolve(payload());
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(api.fetchSubscription).toHaveBeenCalledOnce(); expect(api.commitConfig).toHaveBeenCalledOnce();
  expect(useApp.getState().refreshingIds).toEqual([]);
});

const edits: Array<[string, () => void]> = [
  ['URL编辑', () => useApp.getState().updateProfile('active', { url: 'https://edited.invalid/sub' })],
  ['原文编辑', () => useApp.getState().updateProfile('active', { raw: rawFor('edited-node') })],
  ['重命名', () => useApp.getState().updateProfile('active', { name: '用户新名称' })],
  ['删除', () => { void useApp.getState().removeProfile('active'); }],
  ['切换订阅', () => useApp.setState({ activeId: 'inactive' })],
  ['切走又切回', () => { useApp.setState({ activeId: 'inactive' }); useApp.setState({ activeId: 'active' }); }],
  ['配置端口改变', () => useApp.getState().updateSettings({ controllerPort: 9091 })],
  ['覆写改变', () => useApp.getState().updateSettings({ overrides: [{ id: 'o', name: 'fixture', enabled: true, mode: 'yaml', text: 'log-level: debug' }] })],
  ['配置输入改后还原', () => { useApp.getState().updateSettings({ dnsPort: 1054 }); useApp.getState().updateSettings({ dnsPort: 1053 }); }],
];
it.each(edits)('下载期间%s，迟到响应不覆盖最新意图', async (_name, edit) => {
  const download = deferred<ReturnType<typeof payload>>(); const originalDisk = disk;
  vi.mocked(api.fetchSubscription).mockImplementationOnce(() => download.promise);
  const pending = useApp.getState().refreshProfile('active');
  edit(); const desiredProfiles = useApp.getState().profiles; const desiredId = useApp.getState().activeId;
  download.resolve(payload());
  expect(await pending).toBe(false);
  expect(useApp.getState().profiles).toEqual(desiredProfiles); expect(useApp.getState().activeId).toBe(desiredId);
  expect(disk).toBe(originalDisk); expect(api.commitConfig).not.toHaveBeenCalled();
});

it('校验等待中修改输入，候选被丢弃且不覆盖其他订阅的编辑', async () => {
  const validation = deferred<void>(); const originalDisk = disk;
  vi.mocked(api.validateConfig).mockImplementationOnce(() => validation.promise);
  const pending = useApp.getState().refreshProfile('active');
  await vi.waitFor(() => expect(api.validateConfig).toHaveBeenCalledOnce());
  useApp.getState().updateSettings({ dnsPort: 1054 });
  useApp.getState().updateProfile('inactive', { name: '另一个订阅新名称' });
  validation.resolve(); expect(await pending).toBe(false);
  expect(current()!.raw).toBe(oldRaw); expect(current('inactive')!.name).toBe('另一个订阅新名称');
  expect(disk).toBe(originalDisk); expect(api.discardConfig).toHaveBeenCalledOnce();
});

it('仅外观与其他订阅编辑不使候选失效，成功合并保留这些修改', async () => {
  const download = deferred<ReturnType<typeof payload>>();
  vi.mocked(api.fetchSubscription).mockImplementationOnce(() => download.promise);
  const pending = useApp.getState().refreshProfile('active');
  useApp.getState().updateSettings({ theme: 'dark', textSize: 'large' });
  useApp.getState().updateProfile('inactive', { name: '另一个订阅新名称' });
  download.resolve(payload()); expect(await pending).toBe(true);
  expect(current()!.raw).toBe(newRaw); expect(current('inactive')!.name).toBe('另一个订阅新名称');
  expect(useApp.getState().settings).toMatchObject({ theme: 'dark', textSize: 'large' });
});

it('加载在途时改配置并编辑其他订阅，旧候选补偿回旧运行版本且不回写全局快照', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55 });
  const originalDisk = disk; const loading = deferred<void>();
  vi.mocked(api.mihomo).mockImplementationOnce(async () => { await loading.promise; loaded = disk; return null; });
  const pending = useApp.getState().refreshProfile('active');
  await vi.waitFor(() => expect(api.mihomo).toHaveBeenCalledOnce());
  useApp.getState().updateSettings({ dnsPort: 1054 });
  useApp.getState().updateProfile('inactive', { name: '并发编辑' });
  loading.resolve(); expect(await pending).toBe(false);
  expect(current()!.raw).toBe(oldRaw); expect(current('inactive')!.name).toBe('并发编辑');
  expect(disk).toBe(originalDisk); expect(loaded).toBe(originalDisk); expect(useApp.getState().settings.dnsPort).toBe(1054);
});

it('候选校验失败不提前提交订阅内容', async () => {
  vi.mocked(api.validateConfig).mockRejectedValueOnce(new Error('fixture rejected'));
  expect(await useApp.getState().refreshProfile('active')).toBe(false);
  expect(current()!.raw).toBe(oldRaw);
});

it('合法 provider 订阅与仅直连规则配置可通过候选校验', async () => {
  for (const raw of ['proxy-providers: { remote: { type: http, url: "https://fixture.invalid/nodes", path: ./nodes.yaml } }\nproxy-groups: [{ name: Main, type: select, use: [remote] }]', 'rules: ["MATCH,DIRECT"]']) {
    vi.mocked(api.fetchSubscription).mockResolvedValueOnce(payload(raw));
    expect(await useApp.getState().refreshProfile('inactive')).toBe(true);
    expect(current('inactive')!.raw).toBe(raw);
  }
});

it('本地文件刷新也拒绝损坏候选并保留最后成功原文', async () => {
  useApp.getState().updateProfile('inactive', { sourceType: 'file', url: '/isolated/source.yaml' });
  vi.mocked(api.readSubscriptionFile).mockResolvedValueOnce('<html>invalid source</html>');
  const before = current('inactive');
  expect(await useApp.getState().refreshProfile('inactive')).toBe(false);
  expect(current('inactive')).toEqual(before);
});

it('保存新的远程来源后更新失败，保留新来源和最后成功内容供重试', async () => {
  useApp.getState().updateProfile('inactive', { url: 'https://replacement.invalid/sub', useProxy: true, autoUpdateHours: 6 });
  const saved = current('inactive');
  vi.mocked(api.fetchSubscription).mockRejectedValueOnce(new Error('replacement source unavailable'));
  expect(await useApp.getState().refreshProfile('inactive')).toBe(false);
  expect(api.fetchSubscription).toHaveBeenCalledWith('https://replacement.invalid/sub', undefined);
  expect(current('inactive')).toEqual(saved);
  expect(current('inactive')).toMatchObject({ raw: oldRaw, updatedAt: 123, autoUpdateHours: 6 });
  expect(useApp.getState().profileRefreshErrors.inactive).toContain('保留');
});

it('更换本地文件后校验失败保留已保存来源、节点原文、时间与配额', async () => {
  useApp.getState().updateProfile('inactive', { sourceType: 'file', url: '/isolated/replacement.yaml' });
  const saved = current('inactive');
  vi.mocked(api.readSubscriptionFile).mockResolvedValueOnce(newRaw);
  vi.mocked(api.validateConfig).mockRejectedValueOnce(new Error('replacement file validation failed'));
  expect(await useApp.getState().refreshProfile('inactive')).toBe(false);
  expect(api.readSubscriptionFile).toHaveBeenCalledWith('/isolated/replacement.yaml');
  expect(current('inactive')).toEqual(saved);
  expect(current('inactive')).toMatchObject({ raw: oldRaw, updatedAt: 123, userinfo: { upload: 1, download: 2, total: 10, expire: 0 } });
  expect(useApp.getState().profiles).toHaveLength(2);
  expect(useApp.getState().profileRefreshErrors.inactive).toContain('保留');
});

it('候选移除已固定节点时拒绝接受，保留固定记录与旧运行版本', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55, fixedNodes: { active: { Main: 'old-node' } } });
  const originalDisk = disk;
  expect(await useApp.getState().refreshProfile('active')).toBe(false);
  expect(current()!.raw).toBe(oldRaw); expect(useApp.getState().fixedNodes).toEqual({ active: { Main: 'old-node' } });
  expect(disk).toBe(originalDisk); expect(loaded).toBe(originalDisk);
});

it('正式提交在途时改 URL，回退文件且不发布候选元信息', async () => {
  const committing = deferred<void>(); const originalDisk = disk;
  vi.mocked(api.commitConfig).mockImplementationOnce(async path => {
    await committing.promise; previous.set(path, disk); disk = candidates.get(path)!; return '/isolated/config.yaml';
  });
  const pending = useApp.getState().refreshProfile('active');
  await vi.waitFor(() => expect(api.commitConfig).toHaveBeenCalledOnce());
  useApp.getState().updateProfile('active', { url: 'https://new-source.invalid/sub' });
  committing.resolve(); expect(await pending).toBe(false);
  expect(current()).toMatchObject({ url: 'https://new-source.invalid/sub', raw: oldRaw, name: '旧名称', updatedAt: 123 });
  expect(disk).toBe(originalDisk);
});

it('加载已经发生但响应失败时仍明确恢复旧运行版本', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55 });
  const originalDisk = disk;
  vi.mocked(api.mihomo).mockImplementationOnce(async () => { loaded = disk; throw new Error('fixture response lost after apply'); });
  expect(await useApp.getState().refreshProfile('active')).toBe(false);
  expect(current()!.raw).toBe(oldRaw); expect(disk).toBe(originalDisk); expect(loaded).toBe(originalDisk);
  expect(api.stopKernel).not.toHaveBeenCalled();
  expect(useApp.getState().notify).not.toHaveBeenCalledWith('success', expect.anything());
});

it('运行回退也失败时保留旧订阅并明确未确认运行状态，禁止复用配置启动', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55,
    groups: [{ name: 'Main', type: 'Selector', now: 'old-node', nodes: [{ name: 'old-node', type: 'Socks5', delay: null }] }],
    routing: { primary: 'Main' } as any });
  vi.mocked(api.mihomo).mockRejectedValueOnce(new Error('fixture apply timeout')).mockRejectedValueOnce(new Error('fixture rollback timeout'));
  expect(await useApp.getState().refreshProfile('active')).toBe(false);
  expect(current()!.raw).toBe(oldRaw); expect(useApp.getState().configPath).toBe('');
  expect(useApp.getState().kernelError).toContain('未确认');
  expect(useApp.getState().groups).toEqual([]); expect(useApp.getState().routing).toBeNull();
  expect(useApp.getState().profileRefreshErrors.active).toContain('fixture rollback timeout');
  expect(useApp.getState().notify).not.toHaveBeenCalledWith('success', expect.anything());
  expect(api.stopKernel).not.toHaveBeenCalled();
});

it('加载在途时新内核会话接管，旧事务只回退磁盘，不对新会话发送补偿加载', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55 });
  const loading = deferred<void>(); const originalDisk = disk;
  vi.mocked(api.mihomo).mockImplementationOnce(async () => { await loading.promise; return null; });
  const pending = useApp.getState().refreshProfile('active');
  await vi.waitFor(() => expect(api.mihomo).toHaveBeenCalledOnce());
  useApp.setState({ connectedAt: 99, kernelError: null }); loaded = rawFor('new-session');
  loading.resolve(); expect(await pending).toBe(false);
  expect(nodeIn(loaded)).toBe('new-session'); expect(disk).toBe(originalDisk); expect(current()!.raw).toBe(oldRaw);
  expect(api.mihomo).toHaveBeenCalledOnce(); expect(useApp.getState().kernelError).toBeNull();
});

it('加载期间用户断开后不再补偿运行配置，保留用户停止意图', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55 });
  const loading = deferred<void>();
  vi.mocked(api.mihomo).mockImplementationOnce(async () => { await loading.promise; return null; });
  const pending = useApp.getState().refreshProfile('active');
  await vi.waitFor(() => expect(api.mihomo).toHaveBeenCalledOnce());
  const stopping = useApp.getState().stopKernel(true);
  loading.resolve(); expect(await pending).toBe(false); await stopping;
  expect(api.mihomo).toHaveBeenCalledOnce(); expect(useApp.getState().kernelPhase).toBe('stopped');
  expect(current()!.raw).toBe(oldRaw);
});

it('内核未确认候选中的固定节点时回退，保留固定指令', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55, fixedNodes: { active: { Main: 'old-node' } } });
  vi.mocked(api.fetchSubscription).mockResolvedValueOnce(payload(JSON.stringify({ ...JSON.parse(newRaw),
    proxies: [...JSON.parse(oldRaw).proxies, ...JSON.parse(newRaw).proxies],
    'proxy-groups': [{ name: 'Main', type: 'select', proxies: ['old-node', 'new-node'] }] })));
  const originalDisk = disk;
  vi.mocked(api.mihomo).mockImplementationOnce(async () => { loaded = disk; return null; })
    .mockResolvedValueOnce({ proxies: { Main: { type: 'Selector', now: 'new-node', all: ['old-node', 'new-node'] },
      'old-node': { type: 'Socks5' }, 'new-node': { type: 'Socks5' } } });
  expect(await useApp.getState().refreshProfile('active')).toBe(false);
  expect(current()!.raw).toBe(oldRaw); expect(disk).toBe(originalDisk); expect(loaded).toBe(originalDisk);
  expect(useApp.getState().fixedNodes).toEqual({ active: { Main: 'old-node' } });
});

it('自动更新失败可从对应订阅查询原因，新尝试会清理旧原因', async () => {
  vi.mocked(api.fetchSubscription).mockRejectedValueOnce(new Error('fixture network unavailable'));
  expect(await useApp.getState().refreshProfile('inactive', true)).toBe(false);
  expect(useApp.getState().profileRefreshErrors.inactive).toContain('fixture network unavailable');
  expect(useApp.getState().profileRefreshErrors.inactive).toContain('保留');
  expect(useApp.getState().notify).not.toHaveBeenCalled();
  const download = deferred<ReturnType<typeof payload>>();
  vi.mocked(api.fetchSubscription).mockImplementationOnce(() => download.promise);
  const pending = useApp.getState().refreshProfile('inactive', true);
  expect(useApp.getState().profileRefreshErrors.inactive).toBeUndefined();
  download.resolve(payload()); expect(await pending).toBe(true);
  expect(useApp.getState().profileRefreshErrors.inactive).toBeUndefined();
});

it('已删除或编辑的过期下载报错不写入对应订阅错误状态', async () => {
  const download = deferred<ReturnType<typeof payload>>();
  vi.mocked(api.fetchSubscription).mockImplementationOnce(() => download.promise.then(() => { throw new Error('old URL error'); }));
  const pending = useApp.getState().refreshProfile('inactive');
  useApp.getState().updateProfile('inactive', { url: 'https://edited.invalid/new' });
  download.resolve(payload()); expect(await pending).toBe(false);
  expect(useApp.getState().profileRefreshErrors.inactive).toBeUndefined();
  expect(useApp.getState().notify).not.toHaveBeenCalledWith('error', expect.stringContaining('old URL error'));
});

it('接受停止态候选后复用已校验文件启动', async () => {
  expect(await useApp.getState().refreshProfile('active')).toBe(true);
  expect(current()!.raw).toBe(newRaw);
  await useApp.getState().startKernel(true);
  expect(useApp.getState().kernelPhase).toBe('running'); expect(nodeIn(loaded)).toBe('new-node');
  expect(api.prepareConfig).toHaveBeenCalledOnce(); expect(api.validateConfig).toHaveBeenCalledOnce();
});

it('活动订阅成功更新后保留并确认已有固定节点', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55, fixedNodes: { active: { Main: 'old-node' } } });
  const raw = JSON.stringify({ ...JSON.parse(newRaw), proxies: [...JSON.parse(oldRaw).proxies, ...JSON.parse(newRaw).proxies],
    'proxy-groups': [{ name: 'Main', type: 'select', proxies: ['new-node', 'old-node'] }] });
  vi.mocked(api.fetchSubscription).mockResolvedValueOnce(payload(raw));
  expect(await useApp.getState().refreshProfile('active')).toBe(true);
  expect(current()!.raw).toBe(raw); expect(useApp.getState().groups[0].now).toBe('old-node');
  expect(useApp.getState().fixedNodes).toEqual({ active: { Main: 'old-node' } });
});

it('活动候选无需满足已移除的 GitHub 固定节点偏好', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55 });
  expect(await useApp.getState().refreshProfile('active')).toBe(true);
  expect(current()!.raw).toBe(newRaw);
  expect(useApp.getState().profileRefreshErrors.active).toBeUndefined();
});

it('成功接受活动候选后清除旧运行状态未确认提示', async () => {
  useApp.setState({ kernelPhase: 'running', connectedAt: 55, kernelError: '订阅更新回退未确认' });
  expect(await useApp.getState().refreshProfile('active')).toBe(true);
  expect(useApp.getState().kernelError).toBeNull();
});
