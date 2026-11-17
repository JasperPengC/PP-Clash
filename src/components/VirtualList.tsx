import { useLayoutEffect, useRef, useState, type Key, type ReactNode } from 'react';

/** 固定行高的有界列表：完整数据保留在内存，仅挂载视口及预读行。 */
export function VirtualList<T>({ items, rowHeight, label, className = '', resetKey, maxHeight = 420, itemKey, renderItem }: {
  items: readonly T[]; rowHeight: number; label: string; className?: string; resetKey?: string; maxHeight?: number;
  itemKey: (item: T, index: number) => Key; renderItem: (item: T, index: number) => ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [height, setHeight] = useState(maxHeight);
  const totalHeight = items.length * rowHeight;
  const update = (top: number) => setOffset(Math.max(0, Math.min(top, Math.max(0, totalHeight - (viewport.current?.clientHeight || height)))));
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = () => { if (element.clientHeight) setHeight(element.clientHeight); };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
    setOffset(0);
  }, [resetKey]);
  const visibleCount = Math.ceil(height / rowHeight);
  const first = Math.max(0, Math.min(Math.floor(offset / rowHeight) - 6, items.length - visibleCount));
  const end = Math.min(items.length, first + visibleCount + 12);
  return <div ref={viewport} className={`virtual-list ${className}`} role="list" aria-label={label} tabIndex={0}
    style={{ height: Math.min(totalHeight, maxHeight), maxHeight: 'var(--list-max-height, 55vh)' }}
    onScroll={event => update(event.currentTarget.scrollTop)}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || !['Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) return;
      event.preventDefault();
      const top = event.key === 'Home' ? 0 : event.key === 'End' ? totalHeight : offset + (event.key === 'PageDown' ? height : -height);
      const bounded = Math.max(0, Math.min(top, Math.max(0, totalHeight - (viewport.current?.clientHeight || height))));
      event.currentTarget.scrollTop = bounded;
      update(bounded);
    }}>
    <div className="virtual-list-space" style={{ height: totalHeight }}>
      <div className="virtual-list-window" style={{ transform: `translateY(${first * rowHeight}px)` }}>
        {items.slice(first, end).map((item, index) => <div key={itemKey(item, first + index)} className="virtual-list-item" role="listitem"
          aria-posinset={first + index + 1} aria-setsize={items.length} style={{ height: rowHeight }}>
          {renderItem(item, first + index)}
        </div>)}
      </div>
    </div>
  </div>;
}
