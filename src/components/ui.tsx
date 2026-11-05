import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconCheck, IconChevronDown } from './icons';

/**
 * 跨页面共享的轻量组件。样式全部落在 theme.css 的类里，
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

export type PillTone = 'muted' | 'accent' | 'ok' | 'warn' | 'bad';

export function Pill({
  tone = 'muted',
  icon,
  children,
}: {
  tone?: PillTone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className={`pill ${tone === 'muted' ? '' : tone}`}>
      {icon}
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      <div className="empty-desc">{desc}</div>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
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
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (v: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const el = btnRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      const estimated = Math.min(260, options.length * 32 + 8);
      const top =
        rect.bottom + 6 + estimated > window.innerHeight
          ? Math.max(8, rect.top - estimated - 6)
          : rect.bottom + 6;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 232));
      setPos({ top, left, minWidth: rect.width });
    }

    const close = () => setOpen(false);
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    // 下拉用 fixed 定位：滚动/缩放时直接收起，避免撑出滚动条
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, options.length]);

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
        onClick={() => setOpen((v) => !v)}
      >
        <span className="select-label">{current?.label ?? value}</span>
        <IconChevronDown size={11} />
      </button>
      {open && pos && (
        <div
          className="select-menu"
          role="listbox"
          style={{ top: pos.top, left: pos.left, minWidth: Math.max(pos.minWidth, 120) }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`select-option${o.value === value ? ' active' : ''}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span>{o.label}</span>
              {o.value === value && <IconCheck size={11} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MiniSwitch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`mini-switch${on ? ' on' : ''}`}
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
export function navigate(page: 'overview' | 'proxies' | 'security' | 'profiles' | 'settings' | 'kernel') {
  window.dispatchEvent(new CustomEvent('ppclash:nav', { detail: page }));
}
