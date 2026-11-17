// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnimatedDetails } from '../src/components/AnimatedDetails';

let host: HTMLDivElement; let root: Root;
let animations: Array<{ finish: () => void; cancel: ReturnType<typeof vi.fn> }>;
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  animations = [];
  vi.spyOn(Element.prototype, 'animate').mockImplementation(() => {
    let finish!: () => void; let reject!: () => void;
    const finished = new Promise<void>((yes, no) => { finish = yes; reject = no; });
    const cancel = vi.fn(reject);
    animations.push({ finish, cancel });
    return { finished, cancel } as unknown as Animation;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(AnimatedDetails, { style: { overflow: 'clip' } },
    createElement('summary', null, '展开详情'), createElement('button', null, '详情操作'))));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); document.documentElement.removeAttribute('data-window-visible'); });
const details = () => host.querySelector('details')!;
// happy-dom 的 MouseEvent 在 React 根监听前执行 details 默认行为；浏览器原生点击另有隔离验收。
async function clickSummary() { await act(async () => host.querySelector('summary')!.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))); }
it('展开中反向收起，完成后恢复原overflow并保留收起状态', async () => {
  await clickSummary(); await clickSummary();
  expect(animations).toHaveLength(2);
  await act(async () => animations[1].finish());
  expect(details().open).toBe(false);
  expect(details().style.overflow).toBe('clip');
});
it('隐藏窗口时结束在途动画，不留下裁切或常驻动画', async () => {
  await clickSummary();
  await act(async () => { document.documentElement.dataset.windowVisible = 'false'; });
  expect(animations[0].cancel).toHaveBeenCalled();
  expect(details().open).toBe(true);
  expect(details().style.overflow).toBe('clip');
});
it('内部操作不会触发展开收起，卸载取消未完成动画', async () => {
  await clickSummary();
  await act(async () => host.querySelector('button')!.click());
  expect(animations).toHaveLength(1);
  await act(async () => root.render(null));
  expect(animations[0].cancel).toHaveBeenCalled();
});
