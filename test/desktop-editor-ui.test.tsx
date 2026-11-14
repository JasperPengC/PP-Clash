// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApp } from '../src/store/app';
import { api } from '../src/core/api';
import { checkWebRtc } from '../src/core/selfcheck';
import { OverridePage } from '../src/pages/Override';
import { ProfilesPage } from '../src/pages/Profiles';
import { SecurityPage } from '../src/pages/Security';
import { OverviewPage } from '../src/pages/Overview';
import { DnsPage } from '../src/pages/Dns';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});
vi.mock('../src/core/selfcheck', async original => ({ ...await original<typeof import('../src/core/selfcheck')>(), checkWebRtc: vi.fn() }));
let root: Root; let host: HTMLDivElement;
const initial = useApp.getInitialState();
const notify = vi.fn();

it('覆写等待配置时断开，旧保存流程不能重新启动', async () => {
  let finish!: (value: boolean) => void;
  const apply = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const restart = vi.fn().mockResolvedValue(true);
  useApp.setState({ kernelPhase: 'running', settings: { ...initial.settings, overrides: [{ id: 'rule', name: '测试覆写', enabled: true, mode: 'yaml', text: 'mode: rule' }] }, applyConfig: apply, restartKernel: restart });
  await render(OverridePage);
  await input(host.querySelector('textarea')!, 'mode: global');
  await click(byText('保存并应用'));
  expect(apply).toHaveBeenCalledTimes(1);
  await act(async () => { await initial.disconnect(); });
  await act(async () => finish(true));
  expect(restart).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalledWith('success', expect.anything());
});
beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ ...initial, notify, activeId: 'test-active', profiles: [{ id: 'test-active', name: 'test', raw: 'proxies: []\nproxy-groups: []\nrules: []', url: 'https://example.test', updatedAt: 1, userinfo: null }] });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (page: () => React.JSX.Element) => act(async () => root.render(createElement(page)));
const click = async (el: Element) => act(async () => (el as HTMLElement).click());
const byText = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!;
const input = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

it('覆写草稿切换文件及页面保留，列表开关不会被旧编辑状态覆盖', async () => {
  const files = ['editor-a', 'editor-b'].map((id, i) => ({ id, name: `文件${i}`, enabled: true, mode: 'yaml' as const, text: 'mode: rule' }));
  const apply = vi.fn().mockResolvedValue(true);
  useApp.setState({ settings: { ...initial.settings, overrides: files }, applyConfig: apply });
  await render(OverridePage);
  await input(host.querySelector('textarea')!, 'mode: global');
  await click(host.querySelectorAll('.override-file-select')[1]);
  await click(host.querySelectorAll('.override-file-select')[0]);
  expect(host.querySelector('textarea')!.value).toBe('mode: global');
  await act(async () => root.render(null)); await render(OverridePage);
  expect(host.querySelector('textarea')!.value).toBe('mode: global');
  await click(host.querySelector('.override-file [role=switch]')!);
  expect(host.querySelector('[aria-label="启用覆写"]')?.getAttribute('aria-checked')).toBe('false');
  await click(byText('保存并应用'));
  expect(useApp.getState().settings.overrides[0]).toMatchObject({ enabled: false, text: 'mode: global' });
  expect(host.querySelector('button button')).toBeNull();
});

it('覆写配置生成失败保留输入，不重启内核、不提示成功', async () => {
  const restart = vi.fn();
  useApp.setState({ kernelPhase: 'running', settings: { ...initial.settings, overrides: [{ id: 'editor-error', name: '错误测试', enabled: true, mode: 'yaml', text: 'mode: rule' }] }, applyConfig: vi.fn().mockResolvedValue(false), restartKernel: restart });
  await render(OverridePage); await input(host.querySelector('textarea')!, 'mode: global');
  await click(byText('保存并应用'));
  expect(restart).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalledWith('success', expect.anything());
  expect(host.textContent).toContain('配置生成失败'); expect(host.querySelector('textarea')!.value).toBe('mode: global');
});

it('订阅拉取失败保留 URL，不能把失败当导入成功', async () => {
  useApp.setState({ profiles: [], activeId: null });
  vi.mocked(api.fetchSubscription).mockRejectedValue(new Error('网络失败'));
  await render(ProfilesPage);
  const url = host.querySelector('input')!;
  await input(url, 'https://example.test/sub');
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('导入') && !b.textContent?.includes('文件'))!;
  await click(button);
  expect(url.value).toBe('https://example.test/sub'); expect(useApp.getState().profiles).toHaveLength(0);
});

it('新增非活动订阅保留连接及当前统计，导入锁覆盖完整请求', async () => {
  const oldStats = { proxies: 1 } as any;
  const restart = vi.fn(); const apply = vi.fn();
  useApp.setState({ activeId: 'existing', stats: oldStats, kernelPhase: 'running', restartKernel: restart, applyConfig: apply });
  vi.mocked(api.fetchSubscription).mockResolvedValue({ raw: 'proxies: []\nproxy-groups: []\nrules: []', headers: {} } as any);
  expect(await useApp.getState().importProfile('https://example.test/sub')).toBe(true);
  expect(restart).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled(); expect(useApp.getState().stats).toBe(oldStats);
});

it('安全检测未知结果显示部分未验证，WebRTC异常也能结束', async () => {
  useApp.setState({ kernelPhase: 'running', tunEnabled: true });
  vi.mocked(api.leakCheckIp).mockResolvedValue({ proxied: '1.2.3.4', direct: null } as any);
  vi.mocked(api.leakCheckDns).mockResolvedValue({ kernel_alive: true, system_fake_ip: false } as any);
  vi.mocked(checkWebRtc).mockRejectedValue(new Error('unsupported'));
  await render(SecurityPage); await click(byText('开始检测'));
  expect(host.textContent).toContain('部分未验证'); expect(byText('重新检测').disabled).toBe(false);
});

it('安全策略应用失败停止重启，显示未生效并可重试', async () => {
  const restart = vi.fn();
  useApp.setState({ kernelPhase: 'running', applyConfig: vi.fn().mockResolvedValue(false), restartKernel: restart });
  await render(SecurityPage); await click(host.querySelector('[role=switch]')!);
  expect(restart).not.toHaveBeenCalled(); expect(host.textContent).toContain('未生效'); expect(useApp.getState().policyApplying).toBe(false);
});

it('DNS应用异常释放按钮锁，保留错误和重试入口', async () => {
  useApp.setState({ kernelPhase: 'running', applyConfig: vi.fn().mockRejectedValue(new Error('write failed')) });
  await render(DnsPage); await click(host.querySelector('[aria-label="启用嗅探"]')!);
  expect(host.textContent).toContain('未生效'); expect(host.querySelector<HTMLButtonElement>('[aria-label="启用嗅探"]')!.disabled).toBe(false);
  expect(byText('重试')).toBeTruthy();
});


it('首次使用无订阅可保存 DNS、安全与覆写，不误报配置失败', async () => {
  useApp.setState({ profiles: [], activeId: null });
  await render(DnsPage); await click(host.querySelector('[aria-label="启用嗅探"]')!);
  expect(notify).toHaveBeenLastCalledWith('info', expect.stringContaining('导入订阅'));
  await render(SecurityPage); await click(host.querySelector('[role=switch]')!);
  expect(notify).toHaveBeenLastCalledWith('info', expect.stringContaining('导入订阅'));
  useApp.setState({ settings: { ...useApp.getState().settings, overrides: [{ id: 'new-offline', name: '离线', enabled: true, mode: 'yaml', text: 'mode: rule' }] } });
  await render(OverridePage); await click(byText('保存并应用'));
  expect(notify).toHaveBeenLastCalledWith('success', expect.stringContaining('导入订阅'));
  expect(notify).not.toHaveBeenCalledWith('error', expect.anything());
});

it('安全检测中的连接变化使旧结果失效，不能回填通过', async () => {
  useApp.setState({ kernelPhase: 'running', tunEnabled: true });
  let finish!: (value: any) => void;
  vi.mocked(api.leakCheckIp).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(api.leakCheckDns).mockResolvedValue({ kernel_alive: true, system_fake_ip: true } as any);
  vi.mocked(checkWebRtc).mockResolvedValue({ supported: true, status: 'complete', publicIps: [] });
  await render(SecurityPage); await click(byText('开始检测'));
  await act(async () => useApp.setState({ routeRevision: useApp.getState().routeRevision + 1 }));
  await act(async () => finish({ proxied: '1.2.3.4', direct: null }));
  expect(host.querySelector('.report')).toBeNull(); expect(byText('开始检测')).toBeTruthy();
});

it('新订阅配置校验失败但旧内核仍运行时，恢复当前订阅和统计', async () => {
  const first = useApp.getState().profiles[0];
  const second = { ...first, id: 'second', name: 'second' };
  const stats = { proxyCount: 6 } as any;
  useApp.setState({ profiles: [first, second], stats, kernelPhase: 'running', applyConfig: vi.fn().mockResolvedValue(true), restartKernel: vi.fn().mockResolvedValue(false) });
  await useApp.getState().activate('second');
  expect(useApp.getState().activeId).toBe(first.id); expect(useApp.getState().stats).toBe(stats);
  expect(notify).not.toHaveBeenCalledWith('info', '已切换到 second');
  expect(useApp.getState().activatingProfile).toBe(false);
});


it('连接失败提供明确重试入口，渲染本身不会启动内核', async () => {
  const start = vi.fn().mockResolvedValue(undefined);
  useApp.setState({ kernelPhase: 'failed', kernelError: '端口占用', startKernel: start });
  await render(OverviewPage); expect(start).not.toHaveBeenCalled();
  expect(host.textContent).toContain('端口占用'); await click(byText('重试连接'));
  expect(start).toHaveBeenCalledOnce();
});

it('覆写未保存状态是实时区域，撤销恢复已保存文本', async () => {
  useApp.setState({ settings: { ...initial.settings, overrides: [{ id: 'ov-dirty', name: '草稿检查', enabled: true, mode: 'yaml' as const, text: 'mode: rule' }] } });
  await render(OverridePage);
  await input(host.querySelector('textarea')!, 'mode: global');
  const dirty = [...host.querySelectorAll('[role="status"]')].find(el => el.textContent?.includes('未保存'));
  expect(dirty).toBeTruthy();
  await click(byText('撤销修改'));
  expect(host.querySelector('textarea')!.value).toBe('mode: rule');
  expect([...host.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes('未保存'))).toBe(false);
});

it('刷新活动订阅生成失败时不重启、不提示成功且释放刷新锁', async () => {
  useApp.setState({ kernelPhase: 'running', applyConfig: vi.fn().mockResolvedValue(false), restartKernel: vi.fn() });
  vi.mocked(api.fetchSubscription).mockResolvedValue({ raw: 'proxies: []\nproxy-groups: []\nrules: []', headers: {} } as any);
  expect(await useApp.getState().refreshProfile('test-active')).toBe(false);
  expect(useApp.getState().restartKernel).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalledWith('success', expect.anything());
  expect(useApp.getState().refreshingIds).toEqual([]);
});
