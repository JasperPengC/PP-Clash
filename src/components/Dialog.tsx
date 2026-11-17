import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './use-presence';

export function Dialog({ children, labelledBy, describedBy, busy = false, open = true, returnFocus, onDismiss }: {
  children: ReactNode;
  labelledBy: string;
  describedBy?: string;
  busy?: boolean;
  open?: boolean;
  returnFocus?: HTMLElement | null;
  onDismiss: () => void;
}) {
  const [portal] = useState(() => document.createElement('div'));
  const dialog = useRef<HTMLDivElement>(null);
  const options = useRef({ busy, onDismiss });
  options.current = { busy, onDismiss };
  const present = usePresence(open);

  useLayoutEffect(() => {
    if (!present) return;
    document.body.append(portal);
    return () => { portal.remove(); };
  }, [portal, present]);

  useLayoutEffect(() => {
    if (!open) return;
    const previousFocus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const background = [...document.body.children].filter(node => node !== portal).map(node => ({
      node, inert: node.getAttribute('inert'), hidden: node.getAttribute('aria-hidden'),
    }));
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]',
    ) ?? [])].filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[hidden], [inert], [aria-hidden="true"]'));
    const focusFirst = () => (focusable()[0] ?? dialog.current)?.focus();
    // Move focus before hiding the previous focused control from assistive technology.
    focusFirst();
    for (const { node } of background) { node.setAttribute('inert', ''); node.setAttribute('aria-hidden', 'true'); }
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) focusFirst();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!options.current.busy) options.current.onDismiss();
      } else if (event.key === 'Tab') {
        const items = focusable();
        const current = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) { event.preventDefault(); dialog.current?.focus(); }
        else if (event.shiftKey && current <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && (current < 0 || current === items.length - 1)) { event.preventDefault(); items[0].focus(); }
      }
    };
    document.addEventListener('focusin', onFocus, true);
    // 下拉菜单等子控件先处理 Escape，避免关闭整张弹窗并丢失草稿。
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('keydown', onKey);
      for (const { node, inert, hidden } of background) {
        if (inert === null) node.removeAttribute('inert'); else node.setAttribute('inert', inert);
        if (hidden === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', hidden);
      }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [portal, open]);

  if (!present) return null;
  return createPortal(
    <div className="modal-backdrop" data-motion={open ? 'open' : 'closing'} role="presentation" inert={!open} aria-hidden={!open || undefined}>
      <div ref={dialog} className="modal-card" role={open ? 'dialog' : undefined} aria-modal={open || undefined}
        aria-labelledby={labelledBy} aria-describedby={describedBy} aria-busy={busy} tabIndex={-1}>
        {children}
      </div>
    </div>, portal,
  );
}
