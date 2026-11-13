// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Sidebar, type PageKey } from '../src/components/Sidebar';
import App from '../src/App';
import { DEFAULT_SETTINGS, useApp } from '../src/store/app';

vi.mock('../src/components/VersionBadge', () => ({ VersionBadge: () => createElement('button', { type: 'button', 'aria-label': '检查更新' }, '版本') }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ ...useApp.getInitialState(), settings: { ...DEFAULT_SETTINGS, advancedMode: true } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('分组导航保留全部十三页与原始跳转，当前页具有唯一语义标记', async () => {
  const change = vi.fn();
  await act(async () => root.render(createElement(Sidebar, { current: 'overview', onChange: change })));
  const pages: PageKey[] = ['overview', 'proxies', 'profiles', 'connections', 'security', 'rules', 'logs', 'override', 'kernel', 'resources', 'traffic', 'dns', 'settings'];
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('nav button')];
  expect(buttons).toHaveLength(pages.length);
  for (const button of buttons) await act(async () => button.click());
  expect(change.mock.calls.map(([page]) => page)).toEqual(pages);
  expect(host.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('概览');
  await act(async () => root.render(createElement(Sidebar, { current: 'settings', onChange: change })));
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('设置');
});

it('设置保持独立导航入口，普通模式仍保留基本页与设置', async () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, advancedMode: false } });
  const change = vi.fn();
  await act(async () => root.render(createElement(Sidebar, { current: 'profiles', onChange: change })));
  expect(host.querySelectorAll('nav button')).toHaveLength(6);
  expect(host.querySelector('nav[aria-label="配置与诊断"]')).toBeNull();
  expect(host.querySelector('nav[aria-label="工具"]')).toBeNull();
  const settings = host.querySelector<HTMLButtonElement>('nav[aria-label="设置"] button')!;
  await act(async () => settings.click());
  expect(change).toHaveBeenCalledWith('settings');
});

it('高级模式在原侧栏内响应更新，入口不丢失且不会重复跳转', async () => {
  const change = vi.fn();
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, advancedMode: false } });
  await act(async () => root.render(createElement(Sidebar, { current: 'overview', onChange: change })));
  await act(async () => useApp.setState({ settings: { ...DEFAULT_SETTINGS, advancedMode: true } }));
  expect(host.querySelectorAll('nav button')).toHaveLength(13);
  const dns = [...host.querySelectorAll<HTMLButtonElement>('nav button')].find(button => button.textContent === 'DNS')!;
  await act(async () => dns.click());
  expect(change).toHaveBeenCalledExactlyOnceWith('dns');
});

it('页面头直接占据主区首行，窗口拖拽占位仍留在侧栏而非重复标题栏', async () => {
  await act(async () => root.render(createElement(App)));
  const main = host.querySelector('main.desktop-main');
  expect(main).not.toBeNull();
  expect(main?.querySelector(':scope > .titlebar')).toBeNull();
  expect(main?.querySelector('.page-anim > :first-child')?.classList.contains('page-head')).toBe(true);
  const chrome = host.querySelector('.sidebar > [data-tauri-drag-region]');
  expect(chrome).not.toBeNull();
  expect(chrome?.textContent).toBe('');
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('概览');
});

it('主区更新提示的图标操作带名称，切页仍沿原有回调更新当前页', async () => {
  useApp.setState({ updateInfo: { version: '9.0.0', url: 'https://example.com/update', notes: '' } });
  await act(async () => root.render(createElement(App)));
  const close = host.querySelector<HTMLButtonElement>('.update-banner .icon-btn')!;
  expect(close.getAttribute('aria-label')).toBe('关闭更新提示');
  await act(async () => close.click());
  expect(host.querySelector('.update-banner')).toBeNull();
  const settings = host.querySelector<HTMLButtonElement>('nav[aria-label="设置"] button')!;
  await act(async () => settings.click());
  expect(settings.getAttribute('aria-current')).toBe('page');
  expect(host.querySelector('main .page-anim:not([style*="display: none"]) .page-title')?.textContent).toBe('设置');
});
