import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconChevronDown, IconSearch, IconX } from './icons';
import { usePresence } from './use-presence';

/**
 * 跨页面共享的轻量组件。样式落在桌面共同层与排版令牌里，
 * 组件本身只负责状态、可访问性与少量形状逻辑。
 */

export function Toggle({
  on,
  onChange,
  disabled,
  busy = false,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** 启动/停止中的过渡状态：禁用并显示转圈。 */
  busy?: boolean;
  /** 屏幕阅读器用的描述；视觉上不显示。 */
  label?: string;
}) {
  return (
    <button
      type="button"
      className={`toggle${on ? ' on' : ''}${busy ? ' busy' : ''}`}
      role="switch"
      aria-checked={on}
      aria-busy={busy}
      aria-label={label}
      disabled={disabled || busy}
      onClick={() => onChange(!on)}
    >
      {busy && <span className="toggle-spinner" />}
    </button>
  );
}

export type PillTone = 'neutral' | 'muted' | 'accent' | 'ok' | 'warn' | 'bad';

export type PillProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: PillTone;
  icon?: ReactNode;
};

export function Pill({
  tone = 'neutral',
  icon,
  children,
  className = '',
  ...props
}: PillProps) {
  return (
    <span {...props} className={`pill pill-${tone}${tone === 'muted' || tone === 'neutral' ? '' : ` ${tone}`}${className ? ` ${className}` : ''}`}>
      {icon}
      {children}
    </span>
  );
}

export type SearchFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
};

export function SearchField({ value, onChange, ariaLabel, className = '', onKeyDown, disabled, ...props }: SearchFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const clear = () => { onChange(''); input.current?.focus(); };
  return <div className={`search-field${className ? ` ${className}` : ''}`}>
    <IconSearch size={15} />
    <input {...props} ref={input} type="search" className="input" value={value} disabled={disabled} aria-label={ariaLabel}
      onChange={event => onChange(event.currentTarget.value)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing) return;
        if (event.key === 'Escape' && value) { event.preventDefault(); event.stopPropagation(); clear(); }
        onKeyDown?.(event);
      }} />
    {value && <button type="button" className="icon-btn icon-btn-sm search-clear" aria-label={`清除${ariaLabel}`} disabled={disabled} onClick={clear}>
      <IconX size={15} />
    </button>}
  </div>;
}

export function EmptyState({
  icon,
  title,
  desc,
  action,
  loading = false,
  compact = false,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  action?: ReactNode;
  loading?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`empty${compact ? ' empty-compact' : ''}`} role="status" aria-busy={loading}>
      <div className="empty-icon" aria-hidden="true">{loading ? <Spinner /> : icon}</div>
      <div className="empty-title">{title}</div>
      {desc && <div className="empty-desc">{desc}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ReadError({ message, onRetry, busy = false }: { message: string; onRetry: () => void; busy?: boolean }) {
  return <div className="read-error" role="status">
    <div><strong>读取失败</strong><p>{message}</p></div>
    <button type="button" className="btn btn-sm" disabled={busy} onClick={onRetry}>{busy ? '重试中…' : '重试'}</button>
  </div>;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  options: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="segmented seg seg-motion" role="group" aria-label={ariaLabel}
      data-has-value={options.some(option => option.value === value)}
      style={{ '--seg-count': Math.max(options.length, 1), '--seg-index': Math.max(options.findIndex(option => option.value === value), 0) } as CSSProperties}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled}
          className={`seg-btn${o.value === value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  disabled = false,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (v: T) => void;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const present = usePresence(open, 150);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number; maxHeight: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (open && pos) (menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? menuRef.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();
  }, [open, pos]);

  const dismiss = () => { setOpen(false); btnRef.current?.focus(); };

  useLayoutEffect(() => {
    if (!open) return;
    const el = btnRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const openAbove = below < Math.min(260, options.length * 32 + 8) && above > below;
      const maxHeight = Math.max(40, Math.min(320, openAbove ? above : below));
      const height = Math.min(maxHeight, options.length * 32 + 8);
      const top = openAbove ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 232));
      setPos({ top, left, minWidth: Math.min(rect.width, window.innerWidth - left - 8), maxHeight });
    }

    const close = () => setOpen(false);
    const onDoc = (e: Event) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const onScroll = (e: Event) => {
      // 菜单自身滚动时不能关闭；只有外部页面滚动才收起
      if (ref.current?.contains(e.target as Node) || menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
    };
    const onSurface = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== menuId) close();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('focusin', onDoc);
    document.addEventListener('keydown', onKey);
    document.addEventListener('ppclash:select-open', onSurface);
    document.dispatchEvent(new CustomEvent('ppclash:select-open', { detail: menuId }));
    // 下拉用 fixed 定位：滚动/缩放时直接收起，避免撑出滚动条
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('focusin', onDoc);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('ppclash:select-open', onSurface);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, options.length, menuId]);

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className={`select${className ? ` ${className}` : ''}`} ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className="select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || options.length === 0}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); }
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="select-label">{current?.label ?? value}</span>
        <IconChevronDown size={11} />
      </button>
      {present &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="select-menu"
            data-motion={open ? 'open' : 'closing'}
            inert={!open}
            aria-hidden={!open || undefined}
            role={open ? 'listbox' : undefined}
            aria-label={ariaLabel}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Escape') { e.preventDefault(); dismiss(); return; }
              const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 :
                e.key === 'ArrowDown' ? (index + 1) % items.length : e.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : -1;
              if (next >= 0) { e.preventDefault(); items[next]?.focus(); }
              if (e.key === 'Tab') { setOpen(false); btnRef.current?.focus(); }
            }}
            style={{
              top: pos.top,
              left: pos.left,
              minWidth: Math.max(pos.minWidth, 120),
              maxWidth: Math.max(120, window.innerWidth - pos.left - 8),
              maxHeight: pos.maxHeight,
            }}
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={o.value === value}
                className={`select-option${o.value === value ? ' active' : ''}`}
                onClick={() => {
                  onChange(o.value);
                  dismiss();
                }}
              >
                <span>{o.label}</span>
                {o.value === value && <IconCheck size={11} />}
              </button>
            ))}
          </div>,
          ref.current?.closest('[role="dialog"], [role="alertdialog"], .tp-card') ?? document.body
        )}
    </div>
  );
}

export function MiniSwitch({
  disabled = false,
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`mini-switch${on ? ' on' : ''}`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    >
      <span />
    </button>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={`spinner${small ? ' sm' : ''}`} aria-hidden="true" />;
}

/** 跨页跳转：App.tsx 监听该事件切页。页面内不直接持有路由状态。 */
export function navigate(page: 'overview' | 'proxies' | 'security' | 'profiles' | 'settings' | 'kernel' | 'logs') {
  window.dispatchEvent(new CustomEvent('ppclash:nav', { detail: page }));
}
