type Axis = 'x' | 'y';
type Thumb = { target: HTMLElement; axis: Axis; el: HTMLDivElement; timer: number; travel: number; range: number };

/** 主窗口与快捷面板共享；原生滚动保留，只在滚动时绘制可拖动的覆盖层。 */
export function installOverlayScrollbars() {
  const thumbs = new Map<HTMLElement, Partial<Record<Axis, Thumb>>>();
  let drag: { thumb: Thumb; pointer: number; scroll: number } | null = null;

  const remove = (thumb: Thumb) => {
    window.clearTimeout(thumb.timer);
    thumb.el.remove();
    const pair = thumbs.get(thumb.target);
    if (pair) {
      delete pair[thumb.axis];
      if (!pair.x && !pair.y) thumbs.delete(thumb.target);
    }
    if (drag?.thumb === thumb) drag = null;
  };
  const fade = (thumb: Thumb) => {
    window.clearTimeout(thumb.timer);
    thumb.timer = window.setTimeout(() => {
      if (!thumb.target.isConnected) remove(thumb);
      else if (drag?.thumb !== thumb) thumb.el.classList.remove('visible');
    }, 700);
  };
  const position = (thumb: Thumb) => {
    const { target, axis, el } = thumb;
    if (!target.isConnected) { remove(thumb); return; }
    const rect = target.getBoundingClientRect();
    const vertical = axis === 'y';
    const client = vertical ? target.clientHeight : target.clientWidth;
    const full = vertical ? target.scrollHeight : target.scrollWidth;
    const offset = vertical ? target.scrollTop : Math.abs(target.scrollLeft);
    const track = Math.max(0, client - 8);
    const size = Math.min(track, Math.max(24, track * client / full));
    thumb.range = full - client;
    thumb.travel = track - size;
    if (thumb.range < 2 || track < 24) { remove(thumb); return; }
    const progress = Math.max(0, Math.min(1, offset / thumb.range));
    const x = vertical ? rect.left + target.clientLeft + target.clientWidth - 11 : rect.left + target.clientLeft + 4 + progress * thumb.travel;
    const y = vertical ? rect.top + target.clientTop + 4 + progress * thumb.travel : rect.top + target.clientTop + target.clientHeight - 11;
    el.style.width = `${vertical ? 10 : size}px`;
    el.style.height = `${vertical ? size : 10}px`;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };
  const show = (target: HTMLElement, axis: Axis) => {
    const vertical = axis === 'y';
    const range = vertical ? target.scrollHeight - target.clientHeight : target.scrollWidth - target.clientWidth;
    if (range < 2) return;
    const style = getComputedStyle(target);
    if (!['auto', 'scroll', 'overlay'].includes(vertical ? style.overflowY || style.overflow : style.overflowX || style.overflow)) return;
    let pair = thumbs.get(target);
    if (!pair) { pair = {}; thumbs.set(target, pair); }
    let thumb = pair[axis];
    if (!thumb) {
      const el = document.createElement('div');
      el.className = 'overlay-scrollbar';
      el.dataset.axis = axis;
      el.setAttribute('aria-hidden', 'true');
      document.body.append(el);
      thumb = { target, axis, el, timer: 0, travel: 0, range };
      pair[axis] = thumb;
      const item = thumb;
      el.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        window.clearTimeout(item.timer);
        item.el.classList.add('dragging');
        drag = { thumb: item, pointer: axis === 'y' ? event.clientY : event.clientX,
          scroll: axis === 'y' ? target.scrollTop : target.scrollLeft };
      });
    }
    position(thumb);
    thumb.el.classList.add('visible');
    fade(thumb);
  };
  const onScroll = (event: Event) => {
    // 父容器滚动时先收起其他指示条，避免它们浮在已经移走的内容上。
    for (const pair of thumbs.values()) for (const item of Object.values(pair)) {
      if (item.target !== event.target && drag?.thumb !== item) item.el.classList.remove('visible');
    }
    if (event.target instanceof HTMLElement) {
      show(event.target, 'y');
      show(event.target, 'x');
    }
  };
  const observer = new MutationObserver(records => {
    if (!records.some(record => record.removedNodes.length)) return;
    for (const pair of [...thumbs.values()]) for (const thumb of Object.values(pair)) {
      if (!thumb.target.isConnected) remove(thumb);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const onMove = (event: PointerEvent) => {
    if (!drag) return;
    const { thumb, pointer, scroll } = drag;
    const delta = (thumb.axis === 'y' ? event.clientY : event.clientX) - pointer;
    const next = scroll + delta * thumb.range / Math.max(1, thumb.travel);
    if (thumb.axis === 'y') thumb.target.scrollTop = next;
    else thumb.target.scrollLeft = next;
    position(thumb);
  };
  const endDrag = () => {
    if (!drag) return;
    const thumb = drag.thumb;
    thumb.el.classList.remove('dragging');
    drag = null;
    fade(thumb);
  };
  const onResize = () => {
    for (const pair of thumbs.values()) for (const thumb of Object.values(pair)) {
      position(thumb);
      thumb.el.classList.remove('visible');
    }
  };
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);
  return () => {
    observer.disconnect();
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    window.removeEventListener('blur', endDrag);
    for (const pair of [...thumbs.values()]) for (const thumb of Object.values(pair)) remove(thumb);
  };
}
