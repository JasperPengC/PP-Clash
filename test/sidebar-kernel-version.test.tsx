// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Sidebar } from '../src/components/Sidebar';
import { api } from '../src/core/api';
import { DEFAULT_SETTINGS, useApp } from '../src/store/app';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, api: { ...actual.api, kernelInfo: vi.fn(), listKernelVersions: vi.fn() } };
});
vi.mock('../src/components/VersionBadge', () => ({ VersionBadge: () => createElement('span', null, '应用版本') }));
let host: HTMLDivElement; let root: Root;
const render = () => act(async () => root.render(createElement(Sidebar, { current: 'overview', onChange: vi.fn() })));
const version = () => host.querySelector('.sidebar-runtime-version')?.textContent;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  useApp.setState({ ...useApp.getInitialState(), settings: { ...DEFAULT_SETTINGS }, kernelPhase: 'running', connectedAt: 1 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('运行中显示实际内核版本，完整构建信息放在提示中', async () => {
  vi.mocked(api.kernelInfo).mockResolvedValue({ running: true, version: 'Mihomo Meta v1.20.3 linux amd64', bundledVersion: 'v1.19.32', pid: 1, rssKb: 1, binary: '/custom' });
  await render();
  expect(version()).toBe('v1.20.3');
  expect(host.querySelector('.sidebar-runtime-version')?.getAttribute('title')).toContain('Mihomo Meta v1.20.3');
  expect(api.listKernelVersions).not.toHaveBeenCalled();
});

it('停止时显示已选安装版本，不把内置版本误认为自定义内核版本', async () => {
  useApp.setState({ kernelPhase: 'stopped', settings: { ...DEFAULT_SETTINGS, kernelPath: '/custom' } });
  vi.mocked(api.listKernelVersions).mockResolvedValue([
    { name: 'builtin', version: 'v1.19.32', path: '/builtin', builtin: true, size: 1 },
    { name: 'custom', version: 'v1.18.9', path: '/custom', builtin: false, size: 1 },
  ]);
  await render();
  expect(version()).toBe('v1.18.9');
  expect(api.kernelInfo).not.toHaveBeenCalled();
});

it('无法确认自定义版本时显示未知', async () => {
  useApp.setState({ kernelPhase: 'stopped', settings: { ...DEFAULT_SETTINGS, kernelPath: '/unknown' } });
  vi.mocked(api.listKernelVersions).mockResolvedValue([{ name: 'builtin', version: 'v1.19.32', path: '/builtin', builtin: true, size: 1 }]);
  await render();
  expect(version()).toBe('版本未知');
});

it('重启后丢弃旧请求，节点选择变化不重复读取版本', async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.kernelInfo>>) => void;
  vi.mocked(api.kernelInfo).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await render();
  await act(async () => useApp.setState({ kernelPhase: 'starting' }));
  expect(version()).not.toContain('v1.');
  vi.mocked(api.kernelInfo).mockResolvedValue({ running: true, version: 'v1.20.4', bundledVersion: null, pid: 2, rssKb: 1, binary: '/custom' });
  await act(async () => useApp.setState({ kernelPhase: 'running', connectedAt: 2 }));
  await act(async () => finish({ running: true, version: 'v1.19.1', bundledVersion: null, pid: 1, rssKb: 1, binary: '/old' }));
  expect(version()).toBe('v1.20.4');
  await act(async () => useApp.setState({ groups: [{ name: '代理', type: 'Selector', now: 'A', all: ['A'] }] }));
  expect(api.kernelInfo).toHaveBeenCalledTimes(2);
});

it('版本读取失败不影响运行状态或误报内置版本', async () => {
  vi.mocked(api.kernelInfo).mockRejectedValue(new Error('unavailable'));
  await render();
  expect(version()).toBe('版本未知');
  expect(host.querySelector('.sidebar-runtime-main')?.getAttribute('aria-label')).toContain('运行中');
});
