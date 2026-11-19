// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SecurityPage } from '../src/pages/Security';
import { DnsPage } from '../src/pages/Dns';
import { KernelPage } from '../src/pages/Kernel';
import { useApp } from '../src/store/app';
import { api } from '../src/core/api';

const platform = vi.hoisted(() => ({ isLinux: false }));
vi.mock('../src/core/platform', () => ({
  isAndroid: false,
  isWindows: false,
  get isLinux() { return platform.isLinux; },
}));

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: false, api: { ...actual.api,
    kernelInfo: vi.fn().mockResolvedValue({ running: false, bundledVersion: 'v1.19.32' }),
    listKernelVersions: vi.fn().mockResolvedValue([]), systemHelperInfo: vi.fn().mockResolvedValue({ installed: false }) } };
});
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  platform.isLinux = false;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ ...useApp.getInitialState(), setPolicy: vi.fn(), updateSettings: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it.each([['安全', SecurityPage], ['DNS', DnsPage], ['内核', KernelPage]] as const)('%s 的表单控件有可关联的名称及说明', async (_name, Page) => {
  await act(async () => root.render(createElement(Page)));
  const controls = [...host.querySelectorAll<HTMLElement>('[role="switch"], input, [aria-haspopup="listbox"]')];
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    const group = control.closest('[role="group"][aria-labelledby]')!;
    expect(group).not.toBeNull();
    const label = document.getElementById(group.getAttribute('aria-labelledby')!);
    expect(label?.textContent?.trim()).toBeTruthy();
    const descriptionId = group.getAttribute('aria-describedby');
    if (descriptionId) expect(document.getElementById(descriptionId)?.textContent?.trim()).toBeTruthy();
  }
});

it.each([false, true])('内核提权卸载需要二次确认，确认前不执行卸载（Linux=%s）', async linux => {
  platform.isLinux = linux;
  vi.mocked(api.systemHelperInfo).mockResolvedValue({ installed: true, version: '1.0', needsUpdate: false, path: '/mock/helper' } as any);
  const uninstall = vi.fn().mockResolvedValue({ installed: false, version: null, needsUpdate: false, path: '/mock/helper' });
  (api as { uninstallSystemHelper: unknown }).uninstallSystemHelper = uninstall;
  await act(async () => root.render(createElement(KernelPage)));
  const click = async (element: HTMLButtonElement) => act(async () => element.click());
  const findButton = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text)!;
  const action = linux ? '移除授权' : '卸载';
  const confirmation = linux ? '确认移除' : '确认卸载';
  await click(findButton(action));
  expect(findButton(confirmation)).toBeTruthy();
  expect(uninstall).not.toHaveBeenCalled();
  await click(findButton(confirmation));
  expect(uninstall).toHaveBeenCalledTimes(1);
});
