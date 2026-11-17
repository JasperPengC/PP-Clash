import { useEffect, useRef, type ComponentPropsWithoutRef } from 'react';

/** 保留原生 details/summary 语义；只有用户展开/收起时测量一次，支持中途反向。 */
export function AnimatedDetails({ children, onClick, ...props }: ComponentPropsWithoutRef<'details'>) {
  const element = useRef<HTMLDetailsElement>(null);
  const animation = useRef<Animation | null>(null);
  const targetOpen = useRef(false);
  const overflow = useRef('');
  const settle = (details = element.current) => {
    const current = animation.current;
    if (!details || !current) return;
    animation.current = null;
    details.open = targetOpen.current;
    current.cancel();
    details.style.overflow = overflow.current;
  };
  useEffect(() => {
    const mounted = element.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onVisibility = () => {
      if (document.hidden || document.documentElement.dataset.windowVisible === 'false' || reduced.matches) settle();
    };
    const observer = new MutationObserver(onVisibility);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-window-visible'] });
    document.addEventListener('visibilitychange', onVisibility);
    reduced.addEventListener('change', onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', onVisibility);
      settle(mounted);
    };
  }, []);
  return <details {...props} ref={element} onClick={event => {
    onClick?.(event);
    const details = element.current;
    const summary = details?.querySelector('summary');
    if (event.defaultPrevented || !details || !summary || !(event.target instanceof Node) || !summary.contains(event.target)) return;
    if (typeof details.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden || document.documentElement.dataset.windowVisible === 'false') { settle(); return; }
    event.preventDefault();
    const opening = animation.current ? !targetOpen.current : !details.open;
    targetOpen.current = opening;
    const start = details.getBoundingClientRect().height;
    if (!animation.current) overflow.current = details.style.overflow;
    animation.current?.cancel();
    details.open = true;
    const styles = getComputedStyle(details);
    const inset = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'] as const;
    const end = opening ? details.getBoundingClientRect().height : summary.getBoundingClientRect().height + inset.reduce((sum, key) => sum + (parseFloat(styles[key]) || 0), 0);
    if (!opening && details.contains(document.activeElement)) summary.focus();
    details.style.overflow = 'hidden';
    const next = details.animate([{ height: `${start}px` }, { height: `${end}px` }], {
      duration: opening ? 200 : 150, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both',
    });
    animation.current = next;
    void next.finished.then(() => {
      if (animation.current !== next) return;
      settle();
    }).catch(() => {
      if (animation.current === next) settle();
    });
  }}>{children}</details>;
}
