// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TrafficPage } from '../src/pages/Traffic';
import { useApp } from '../src/store/app';
import { api } from '../src/core/api';

const platform = vi.hoisted(() => ({ android: false }));
vi.mock('../src/core/platform', () => ({ get isAndroid() { return platform.android; }, isWindows: false, isLinux: false }));
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, api: { ...actual.api, mihomo: vi.fn() } };
});
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  platform.android = false;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ ...useApp.getInitialState(), kernelPhase: 'running' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

it('Android 没有进程归属信息时只显示有效的节点流量统计', async () => {
  platform.android = true;
  vi.mocked(api.mihomo).mockResolvedValue({ connections: [{
    id: 'mobile', upload: 123, download: 456, chains: ['Tokyo'], metadata: {},
  }], uploadTotal: 123, downloadTotal: 456 });
  await act(async () => root.render(createElement(TrafficPage)));
  expect(host.querySelector('[aria-label="节点流量列表"]')?.textContent).toContain('Tokyo');
  expect(host.querySelector('[aria-label="按进程统计"]')).toBeNull();
  expect(host.textContent).not.toContain('未知');
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

it('一万组节点和进程流量各自限制DOM，独立滚动仍能到达最后一项', async () => {
  vi.mocked(api.mihomo).mockResolvedValue({ connections: Array.from({ length: 10000 }, (_, i) => ({
    id: `conn-${i}`, upload: i, download: i, chains: [`node-${i}`], metadata: { process: `process-${i}` },
  })), uploadTotal: 123456, downloadTotal: 987654 });
  await act(async () => root.render(createElement(TrafficPage)));
  const nodeList = host.querySelector<HTMLElement>('[aria-label="节点流量列表"]')!;
  const processList = host.querySelector<HTMLElement>('[aria-label="进程流量列表"]')!;
  expect(host.textContent).toContain('10000 个节点');
  expect(host.textContent).toContain('10000 个进程');
  for (const list of [nodeList, processList]) {
    expect(list.querySelectorAll('[role="listitem"]').length).toBeLessThanOrEqual(30);
    expect(list.querySelector('[role="listitem"]')?.getAttribute('aria-setsize')).toBe('10000');
  }
  await act(async () => processList.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(processList.textContent).toContain('process-0');
  expect(nodeList.textContent).toContain('node-9999');
  expect(nodeList.textContent).not.toContain('node-0');
  await act(async () => nodeList.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(nodeList.textContent).toContain('node-0');
});
