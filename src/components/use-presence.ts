import { useLayoutEffect, useState } from 'react';

/** 逻辑关闭与焦点立即生效，仅保留退出画面；不在静止时持有计时器。 */
export function usePresence(open: boolean, duration = 120) {
  const [mounted, setMounted] = useState(open);
  useLayoutEffect(() => {
    if (open) { setMounted(true); return; }
    if (!mounted) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finish = () => setMounted(false);
    const hidden = () => document.hidden || document.documentElement.dataset.windowVisible === 'false';
    if (reduced.matches || hidden()) { finish(); return; }
    const timer = window.setTimeout(finish, duration);
    const onVisibility = () => { if (hidden() || reduced.matches) finish(); };
    const observer = new MutationObserver(onVisibility);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-window-visible'] });
    reduced.addEventListener('change', onVisibility);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      reduced.removeEventListener('change', onVisibility);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [open, mounted, duration]);
  return open || mounted;
}
