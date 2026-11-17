// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp, type Profile } from '../src/store/app';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});
const raw = JSON.stringify({ proxies: [{ name: 'A', type: 'socks5', server: 'fixture.invalid', port: 1080 }] });
const existing: Profile = { id: 'existing', name: '已有订阅', url: 'https://existing.invalid/sub', raw,
  updatedAt: 1, userinfo: null, updateIntervalHours: null };
beforeEach(() => {
  vi.resetAllMocks();
  Object.values(api).forEach(fn => vi.mocked(fn).mockResolvedValue(undefined as never));
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: false, port: 7890 } as any);
  useApp.setState({ ...useApp.getInitialState(), profiles: [existing], activeId: existing.id,
    notify: vi.fn(), applyConfig: vi.fn().mockResolvedValue(true), restartKernel: vi.fn().mockResolvedValue(true) });
  vi.mocked(api.fetchSubscription).mockResolvedValue({ raw, profileTitle: null, contentDisposition: null, subscriptionUserinfo: null, profileUpdateInterval: null });
  vi.mocked(api.readSubscriptionFile).mockResolvedValue(raw);
  vi.mocked(api.prepareConfig).mockResolvedValue('/isolated/candidate.yaml');
});

it.each(['not-a-url', 'file:///private/config.yaml', 'https://'])('拒绝非法订阅链接 %s，不下载或修改订阅', async url => {
  expect(await useApp.getState().importProfile(url)).toBe(false);
  expect(api.fetchSubscription).not.toHaveBeenCalled();
  expect(useApp.getState().profiles).toEqual([existing]);
});

it.each(['', '<html>登录页面</html>', 'proxies: []\nproxy-groups: []\nrules: []'])('无效下载内容 %j 不进入订阅列表', async invalid => {
  vi.mocked(api.fetchSubscription).mockResolvedValue({ raw: invalid } as any);
  expect(await useApp.getState().importProfile('https://new.invalid/sub')).toBe(false);
  expect(useApp.getState().profiles).toEqual([existing]);
  expect(useApp.getState().activeId).toBe('existing');
});

it.each(['url', 'file'] as const)('%s 候选语义校验失败不发布新订阅，临时文件被回收', async source => {
  vi.mocked(api.validateConfig).mockRejectedValue(new Error('invalid proxy server'));
  const result = source === 'url' ? await useApp.getState().importProfile('https://new.invalid/sub')
    : await useApp.getState().importProfileFile('/isolated/local.yaml');
  expect(result).toBe(false);
  expect(useApp.getState().profiles).toEqual([existing]);
  expect(useApp.getState().notify).toHaveBeenCalledWith('error', expect.stringContaining('invalid proxy server'));
  expect(api.discardConfig).toHaveBeenCalledWith('/isolated/candidate.yaml');
});

it('重复链接只提示使用已有订阅，不重复下载或追加', async () => {
  expect(await useApp.getState().importProfile('  https://existing.invalid/sub  ')).toBe(false);
  expect(useApp.getState().profiles).toEqual([existing]);
  expect(api.fetchSubscription).not.toHaveBeenCalled();
});

it('重复本地来源不重复读取或追加', async () => {
  useApp.setState({ profiles: [{ ...existing, sourceType: 'file', url: '/isolated/local.yaml' }] });
  expect(await useApp.getState().importProfileFile('/isolated/local.yaml')).toBe(false);
  expect(useApp.getState().profiles).toHaveLength(1);
  expect(api.readSubscriptionFile).not.toHaveBeenCalled();
});

it('有效备用订阅经校验后保存，不打断活动配置', async () => {
  useApp.setState({ kernelPhase: 'running' });
  expect(await useApp.getState().importProfile('https://new.invalid/sub')).toBe(true);
  expect(useApp.getState().profiles).toHaveLength(2);
  expect(useApp.getState().activeId).toBe('existing');
  expect(api.validateConfig).toHaveBeenCalledWith('/isolated/candidate.yaml', '/isolated');
  expect(api.discardConfig).toHaveBeenCalledWith('/isolated/candidate.yaml');
  expect(useApp.getState().applyConfig).not.toHaveBeenCalled();
  expect(useApp.getState().restartKernel).not.toHaveBeenCalled();
});

it('导入期间生命周期变化后丢弃迟到结果', async () => {
  let finish!: (value: any) => void;
  vi.mocked(api.fetchSubscription).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const pending = useApp.getState().importProfile('https://new.invalid/sub');
  await useApp.getState().stopKernel();
  finish({ raw });
  expect(await pending).toBe(false);
  expect(useApp.getState().profiles).toEqual([existing]);
});

it.each(['url', 'file'] as const)('%s 首次导入修复悬空活动ID，校验完成后才自动使用', async source => {
  useApp.setState({ profiles: [], activeId: 'removed-profile' });
  const result = source === 'url' ? await useApp.getState().importProfile('https://new.invalid/sub')
    : await useApp.getState().importProfileFile('/isolated/local.yaml');
  expect(result).toBe(true);
  expect(useApp.getState().profiles).toHaveLength(1);
  expect(useApp.getState().activeId).toBe(useApp.getState().profiles[0].id);
  expect(api.validateConfig).toHaveBeenCalled();
  expect(useApp.getState().applyConfig).toHaveBeenCalledTimes(1);
});
