// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResourcesPage } from '../src/pages/Resources';
import { KernelPage } from '../src/pages/Kernel';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';

const native = vi.hoisted(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  return { invoke: vi.fn() };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});
let root: Root;
let host: HTMLDivElement;
const notify = vi.fn();
const info = { running: true, version: 'v1.2.3', pid: 1, rssKb: 1024, binary: '/mock/kernel', bundledVersion: 'v1.2.3' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label || (label === '刷新' && b.getAttribute('aria-label')?.startsWith('刷新')))!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const render = async (Page: typeof ResourcesPage | typeof KernelPage) => { await act(async () => root.render(createElement(Page))); };
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  native.invoke.mockResolvedValue(undefined);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  useApp.setState({ ...useApp.getInitialState(), kernelPhase: 'running', notify,
    updateSettings: vi.fn(), applyConfig: vi.fn().mockResolvedValue(true), restartKernel: vi.fn().mockResolvedValue(true) });
  vi.mocked(api.listResourceFiles).mockResolvedValue([{ name: 'geoip.dat', exists: true, size: 1024 }]);
  vi.mocked(api.mihomo).mockResolvedValue({ providers: {} });
  vi.mocked(api.kernelInfo).mockResolvedValue(info);
  vi.mocked(api.listKernelVersions).mockResolvedValue([]);
  vi.mocked(api.systemHelperInfo).mockResolvedValue({ installed: false, version: null, needsUpdate: false, path: '/mock' });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it('局域网认证或监听未就绪时不能开启，条件齐全后才可开启', async () => {
  await render(KernelPage);
  const control = () => host.querySelector<HTMLButtonElement>('[aria-label="允许局域网连接"]')!;
  expect(control().disabled).toBe(true);
  expect(control().getAttribute('aria-checked')).toBe('false');
  await act(async () => useApp.setState(state => ({ settings: { ...state.settings, authUser: 'user', authPass: 'pass', bindAddress: '0.0.0.0' } })));
  expect(control().disabled).toBe(false);
});

it('资源读取分别失败仍保留成功列表，失败不伪装空数据', async () => {
  vi.mocked(api.listResourceFiles).mockRejectedValue(new Error('disk denied'));
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => {
    if (path === '/providers/rules') throw new Error('rules offline');
    return { providers: { Airport: { vehicleType: 'HTTP', proxies: ['A'] } } };
  });
  await render(ResourcesPage);
  expect(host.textContent).toContain('disk denied');
  expect(host.textContent).not.toContain('缺失');
  await click(button('规则提供者'));
  expect(host.textContent).toContain('rules offline');
  expect(host.textContent).not.toContain('没有规则提供者');
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith('代理提供者'))!);
  expect(host.textContent).toContain('Airport');
});

it('资源加载不提前报告缺失，失败刷新标记旧数据并可重试', async () => {
  const pending = deferred<Awaited<ReturnType<typeof api.listResourceFiles>>>();
  vi.mocked(api.listResourceFiles).mockReturnValueOnce(pending.promise);
  await render(ResourcesPage);
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(host.textContent).not.toContain('缺失');
  await act(async () => pending.resolve([{ name: 'geoip.dat', exists: true, size: 1024 }]));
  vi.mocked(api.listResourceFiles).mockRejectedValueOnce(new Error('read interrupted'));
  await click(button('刷新'));
  expect(host.textContent).toContain('上次');
  expect(host.textContent).toContain('read interrupted');
  await click(button('重试'));
  expect(host.textContent).not.toContain('read interrupted');
});

it('资源错误摘要指向失败分类，切换后重试读取且保留其他成功数据', async () => {
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => {
    if (path === '/providers/rules') throw new Error('rules offline');
    return { providers: { Airport: { vehicleType: 'HTTP', proxies: ['A'] } } };
  });
  await render(ResourcesPage);
  expect(host.querySelector('.page-sub')?.textContent).toContain('规则提供者读取失败');
  expect(host.querySelector('.page-sub')?.textContent).not.toContain('内置数据读取失败');
  expect(host.querySelector('.geo-source-list')?.textContent).toContain('就绪');
  const errorLink = host.querySelector<HTMLButtonElement>('[aria-label="查看规则提供者读取错误"]');
  expect(errorLink).not.toBeNull();
  const reads = vi.mocked(api.mihomo).mock.calls.length;
  await click(errorLink!);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('规则提供者');
  expect(host.querySelector('.read-error')?.textContent).toContain('rules offline');
  expect(api.mihomo).toHaveBeenCalledTimes(reads);
  const pending = deferred<any>();
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => path === '/providers/rules'
    ? pending.promise : { providers: { Airport: { vehicleType: 'HTTP', proxies: ['A'] } } });
  const retry = button('重试');
  await click(retry);
  expect(retry.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[aria-label="刷新资源"]')!.disabled).toBe(true);
  const retryReads = vi.mocked(api.mihomo).mock.calls.length;
  await click(retry);
  expect(api.mihomo).toHaveBeenCalledTimes(retryReads);
  await act(async () => pending.resolve({ providers: { Rules: { vehicleType: 'HTTP', ruleCount: 12 } } }));
  expect(host.querySelector('.page-sub')?.textContent).not.toContain('读取失败');
  expect(host.textContent).toContain('Rules');
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith('代理提供者'))!);
  expect(host.textContent).toContain('Airport');
});

it('多个资源类型读取失败时页头逐项指出，内置数据错误也可直接定位', async () => {
  vi.mocked(api.listResourceFiles).mockRejectedValue(new Error('disk denied'));
  vi.mocked(api.mihomo).mockRejectedValue(new Error('controller offline'));
  await render(ResourcesPage);
  const summary = host.querySelector('.page-sub')!;
  expect(summary.textContent).toContain('内置数据读取失败');
  expect(summary.textContent).toContain('规则提供者读取失败');
  expect(summary.textContent).toContain('代理提供者读取失败');
  await click(host.querySelector<HTMLElement>('[aria-label="查看代理提供者读取错误"]')!);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('代理提供者');
  await click(host.querySelector<HTMLElement>('[aria-label="查看内置数据读取错误"]')!);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('内置数据');
  expect(host.querySelector('.read-error')?.textContent).toContain('disk denied');
  expect(button('重试').disabled).toBe(false);
});

it('提供者批量更新全程锁定且准确汇报部分失败', async () => {
  const pending = deferred<unknown>();
  vi.mocked(api.mihomo).mockImplementation(async (method, path) => {
    if (method === 'GET') return { providers: { A: {}, B: {} } };
    if (path.endsWith('/A')) return pending.promise;
    throw new Error('B unavailable');
  });
  await render(ResourcesPage);
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith('规则提供者'))!);
  await click(button('更新当前列表'));
  expect(button('更新当前列表').disabled).toBe(true);
  await click(button('更新当前列表'));
  await act(async () => pending.resolve({}));
  expect(vi.mocked(api.mihomo).mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(2);
  expect(notify.mock.calls.some(([kind, message]) => kind === 'error' && String(message).includes('B'))).toBe(true);
  expect(button('更新当前列表').disabled).toBe(false);
});

it('内核三种读取失败分别可重试，不推断未运行或未安装', async () => {
  vi.mocked(api.kernelInfo).mockRejectedValue(new Error('info unavailable'));
  vi.mocked(api.listKernelVersions).mockRejectedValue(new Error('versions unavailable'));
  vi.mocked(api.systemHelperInfo).mockRejectedValue(new Error('helper unavailable'));
  await render(KernelPage);
  expect(host.textContent).toContain('info unavailable');
  expect(host.textContent).toContain('versions unavailable');
  expect(host.textContent).toContain('helper unavailable');
  expect(host.textContent).not.toContain('未安装');
  expect(host.textContent).not.toContain('未运行');
  vi.mocked(api.kernelInfo).mockResolvedValue(info);
  vi.mocked(api.listKernelVersions).mockResolvedValue([]);
  vi.mocked(api.systemHelperInfo).mockResolvedValue({ installed: true, version: 'v1.2.3', needsUpdate: false, path: '/mock' });
  await click(button('刷新'));
  expect(host.textContent).not.toContain('unavailable');
  expect(host.textContent).toContain('已安装');
});

it('内核手动刷新与定时读取不会重入，后续失败标记旧数据', async () => {
  const pending = deferred<typeof info>();
  vi.mocked(api.kernelInfo).mockReturnValueOnce(pending.promise);
  await render(KernelPage);
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  await click(button('刷新'));
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(api.kernelInfo).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(info));
  vi.mocked(api.kernelInfo).mockRejectedValueOnce(new Error('refresh failed'));
  await click(button('刷新'));
  expect(host.textContent).toContain('上次');
  expect(host.textContent).toContain('refresh failed');
});

it('内核运行设置失败时不报告成功，并锁住连续操作', async () => {
  useApp.setState(state => ({ settings: { ...state.settings, authUser: 'user', authPass: 'pass', bindAddress: '0.0.0.0' } }));
  const pending = deferred<boolean>();
  const apply = vi.fn().mockReturnValue(pending.promise);
  useApp.setState({ applyConfig: apply });
  await render(KernelPage);
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="允许局域网连接"]')!;
  await click(toggle); await click(toggle);
  expect(apply).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(false));
  expect(useApp.getState().restartKernel).not.toHaveBeenCalled();
  expect(notify.mock.calls.some(([kind]) => kind === 'info' || kind === 'success')).toBe(false);
});

it('内核后台采样不会禁用正在编辑的端口，提交等读取结束后执行', async () => {
  useApp.setState(state => ({ settings: { ...state.settings, authUser: 'user', authPass: 'pass', bindAddress: '0.0.0.0' } }));
  await render(KernelPage);
  const pending = deferred<typeof info>();
  vi.mocked(api.kernelInfo).mockReturnValueOnce(pending.promise);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(host.querySelector<HTMLInputElement>('input[aria-label="混合端口"]')!.disabled).toBe(false);
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="允许局域网连接"]')!);
  expect(useApp.getState().applyConfig).not.toHaveBeenCalled();
  await act(async () => pending.resolve(info));
  expect(useApp.getState().applyConfig).toHaveBeenCalledTimes(1);
});

it('提权内核安装返回未安装时不得报告安装成功', async () => {
  vi.mocked(api.installSystemHelper).mockResolvedValue({ installed: false, version: null, needsUpdate: false, path: '/mock' });
  await render(KernelPage);
  await click(button('安装'));
  expect(notify.mock.calls.some(([kind]) => kind === 'success')).toBe(false);
  expect(notify.mock.calls.some(([kind]) => kind === 'error')).toBe(true);
});

async function commitPort(index: number, value: number) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${index === 0 ? '混合端口' : '控制端口'}"]`)!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.blur());
}

it.each([
  ['mixedPort', 0, 7891, 'apply'], ['mixedPort', 0, 7891, 'restart'], ['mixedPort', 0, 7891, 'throw'],
  ['controllerPort', 1, 9091, 'apply'], ['controllerPort', 1, 9091, 'restart'], ['controllerPort', 1, 9091, 'throw'],
] as const)('%s 修改在 %s / %s / %s 失败时回滚真实设置和原生目标', async (field, index, nextPort, failure) => {
  const actual = await vi.importActual<typeof import('../src/core/api')>('../src/core/api');
  actual.setMihomoBase(9090);
  vi.mocked(api.setSystemProxy).mockImplementation(actual.api.setSystemProxy);
  useApp.setState({ updateSettings: useApp.getInitialState().updateSettings, sysProxyEnabled: true });
  const previous = useApp.getState().settings[field];
  if (failure === 'throw') vi.mocked(useApp.getState().applyConfig).mockRejectedValueOnce(new Error('write denied'));
  else vi.mocked(failure === 'apply' ? useApp.getState().applyConfig : useApp.getState().restartKernel).mockResolvedValueOnce(false);
  await render(KernelPage);
  await commitPort(index, nextPort);
  expect(useApp.getState().settings[field]).toBe(previous);
  expect(host.querySelector<HTMLInputElement>(`input[aria-label="${index === 0 ? '混合端口' : '控制端口'}"]`)!.value).toBe(String(previous));
  expect(useApp.getState().kernelPhase).toBe('running');
  expect(notify).toHaveBeenCalledWith('error', expect.any(String));
  expect(notify.mock.calls.some(([kind]) => kind === 'info' || kind === 'success')).toBe(false);
  if (field === 'mixedPort') {
    const targets = native.invoke.mock.calls.filter(([command]) => command === 'set_system_proxy').map(([, args]) => args.port);
    expect(targets).toEqual([7891, 7890]);
  } else {
    await actual.api.mihomo('GET', '/version');
    expect(native.invoke).toHaveBeenLastCalledWith('mihomo_request', expect.objectContaining({ base: 'http://127.0.0.1:9090' }));
  }
});

it('没有活动订阅且离线时保留端口设置，并明确提示导入后生效', async () => {
  useApp.setState({ kernelPhase: 'stopped', updateSettings: useApp.getInitialState().updateSettings,
    activeId: 'missing', profiles: [] });
  await render(KernelPage);
  await commitPort(0, 7891);
  expect(useApp.getState().settings.mixedPort).toBe(7891);
  expect(useApp.getState().applyConfig).not.toHaveBeenCalled();
  expect(useApp.getState().restartKernel).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith('info', expect.stringContaining('导入'));
  expect(notify.mock.calls.some(([kind]) => kind === 'error')).toBe(false);
});

it.each([
  ['bindAddress', '监听地址', '0.0.0.0'], ['authUser', '认证用户名', 'user'], ['authPass', '认证密码', 'secret'],
] as const)('%s 应用失败后输入框与已保存设置一致', async (field, label, value) => {
  useApp.setState({ updateSettings: useApp.getInitialState().updateSettings });
  vi.mocked(useApp.getState().applyConfig).mockResolvedValueOnce(false);
  const previous = useApp.getState().settings[field];
  await render(KernelPage);
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.blur());
  expect(useApp.getState().settings[field]).toBe(previous);
  expect(host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.value).toBe(previous);
});

it('提供者筛选是有名称的真实输入，代理提供者列表使用共享行结构', async () => {
  vi.mocked(api.mihomo).mockResolvedValue({ providers: { Airport: { vehicleType: 'HTTP', proxies: ['A'] } } } as any);
  await render(ResourcesPage);
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith('代理提供者'))!);
  const filter = host.querySelector<HTMLInputElement>('[aria-label="筛选提供者"]')!;
  expect(filter).toBeTruthy(); expect(filter.tagName).toBe('INPUT');
  expect(host.querySelector('.resource-provider')).not.toBeNull();
  expect(host.textContent).toContain('Airport');
});
