// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { installOverlayScrollbars } from '../src/core/overlay-scrollbars';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; document.body.replaceChildren(); vi.useRealTimers(); });

function viewport(axis: 'x' | 'y') {
  const node = document.createElement('div');
  node.style.overflow = 'auto';
  document.body.append(node);
  Object.defineProperties(node, {
    clientHeight: { value: 100 }, scrollHeight: { value: axis === 'y' ? 500 : 100 },
    clientWidth: { value: 200 }, scrollWidth: { value: axis === 'x' ? 1000 : 200 },
  });
  node.getBoundingClientRect = () => ({ top: 20, bottom: 120, left: 10, right: 210,
    width: 200, height: 100, x: 10, y: 20, toJSON: () => ({}) });
  return node;
}

it('默认不创建占位，滚动时覆盖在视口内，停止后淡出', () => {
  vi.useFakeTimers();
  const node = viewport('y');
  cleanup = installOverlayScrollbars();
  expect(document.querySelector('.overlay-scrollbar')).toBeNull();
  node.scrollTop = 100;
  node.dispatchEvent(new Event('scroll'));
  const thumb = document.querySelector<HTMLElement>('.overlay-scrollbar[data-axis="y"]')!;
  expect(thumb.parentElement).toBe(document.body);
  expect(thumb.classList.contains('visible')).toBe(true);
  expect(Number.parseFloat(thumb.style.height)).toBeLessThan(node.clientHeight);
  vi.advanceTimersByTime(800);
  expect(thumb.classList.contains('visible')).toBe(false);
});

it('横向滚动也使用悬浮条，拖动滑块会滚动对应内容', () => {
  const node = viewport('x');
  cleanup = installOverlayScrollbars();
  node.dispatchEvent(new Event('scroll'));
  const thumb = document.querySelector<HTMLElement>('.overlay-scrollbar[data-axis="x"]')!;
  expect(thumb).not.toBeNull();
  thumb.dispatchEvent(new PointerEvent('pointerdown', { clientX: 20, button: 0, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: 60 }));
  expect(node.scrollLeft).toBeGreaterThan(0);
  window.dispatchEvent(new PointerEvent('pointerup'));
});

it('界面切换移除滚动容器后清理悬浮条，卸载不遗留计时器或监听', async () => {
  vi.useFakeTimers();
  const node = viewport('y');
  cleanup = installOverlayScrollbars();
  node.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(800);
  node.remove();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.querySelector('.overlay-scrollbar')).toBeNull();
  cleanup(); cleanup = undefined;
  const next = viewport('y');
  next.dispatchEvent(new Event('scroll'));
  expect(document.querySelector('.overlay-scrollbar')).toBeNull();
});
