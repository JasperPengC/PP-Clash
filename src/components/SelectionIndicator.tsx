import { useLayoutEffect, useRef } from 'react';

/** 选择面跟随实际按钮尺寸；滚动与横竖屏共用坐标，不依赖索引均分。 */
export function SelectionIndicator({ value }: { value: string | undefined }) {
  const ref = useRef<HTMLSpanElement>(null);
  const update = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const indicator = ref.current;
    const track = indicator?.parentElement;
    if (!indicator || !track) return;
    const measure = () => {
      const selected = track.querySelector<HTMLElement>('button[aria-current]');
      if (!selected || !selected.offsetWidth || !selected.offsetHeight) {
        indicator.hidden = true;
        return;
      }
      indicator.hidden = false;
      // offset 坐标不受按压缩放影响；选择面在同一滚动容器内自然跟随滚动。
      indicator.style.transform = `translate3d(${selected.offsetLeft}px, ${selected.offsetTop}px, 0)`;
      indicator.style.width = `${selected.offsetWidth}px`;
      indicator.style.height = `${selected.offsetHeight}px`;
    };
    update.current = measure;
    measure();
    const frame = requestAnimationFrame(() => { indicator.dataset.animated = 'true'; });
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    track.querySelectorAll('button').forEach(button => observer.observe(button));
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [value]);

  // 数量、文案变化也会改变前面按钮的宽度，无需每帧测量或 React 状态回写。
  useLayoutEffect(() => { update.current(); });
  return <span ref={ref} className="selection-indicator" aria-hidden="true" />;
}
