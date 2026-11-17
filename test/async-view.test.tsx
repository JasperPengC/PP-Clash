// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { asyncView } from '../src/components/AsyncView';

const mounted: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of mounted.splice(0)) await dispose(); vi.restoreAllMocks(); });
function mount() {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  mounted.push(async () => { await act(async () => root.unmount()); host.remove(); });
  return { host, root };
}

it('未显示的页面不触发加载，等待期间显示状态，完成后显示内容', async () => {
  let complete!: (value: { default: () => ReturnType<typeof createElement> }) => void;
  let requests = 0;
  const View = asyncView(() => { requests++; return new Promise(resolve => { complete = resolve; }); });
  expect(requests).toBe(0);
  const { root, host } = mount();
  await act(async () => root.render(createElement(View)));
  expect(host.querySelector('[role="status"]')?.textContent).toContain('加载中');
  await act(async () => complete({ default: () => createElement('h1', {}, '编辑配置') }));
  expect(host.textContent).toBe('编辑配置');
  expect(requests).toBe(1);
});

it('加载失败可重试，成功模块在页面重新进入时复用', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let requests = 0;
  const View = asyncView(async () => {
    if (++requests === 1) throw Error('offline');
    return { default: () => createElement('h1', {}, '加载成功') };
  });
  const { root, host } = mount();
  await act(async () => root.render(createElement(View)));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('加载失败');
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.textContent).toBe('加载成功');
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(View)));
  expect(host.textContent).toBe('加载成功');
  expect(requests).toBe(2);
});
