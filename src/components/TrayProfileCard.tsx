import { useEffect, useRef, useState } from 'react';
import type { TrayProfile } from '../core/api';
import { formatBytes, formatExpire, formatTime } from '../core/format';
import { IconCheck, IconRefresh } from './icons';

/** 快捷面板只消费摘要，不载入主窗口 store 或订阅原文。 */
export function TrayProfileCard({ profile, selected, disabled, onUse, onRefresh }: {
  profile: TrayProfile; selected: boolean; disabled: boolean;
  onUse: () => void; onRefresh: () => Promise<void>;
}) {
  const [status, setStatus] = useState<'idle' | 'busy' | 'success' | 'error'>('idle');
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const update = async () => {
    if (pending.current || disabled) return;
    pending.current = true;
    setStatus('busy');
    try {
      await onRefresh();
      if (alive.current) setStatus('success');
    } catch {
      if (alive.current) setStatus('error');
    } finally { pending.current = false; }
  };
  const info = profile.userinfo;
  const safe = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
  const used = info ? safe(info.upload) + safe(info.download) : 0;
  const total = info ? safe(info.total) : 0;
  const ratio = total > 0 ? Math.min(used / total, 1) : 0;
  const expired = Boolean(info?.expire && info.expire * 1000 < Date.now());
  return <article className="tp-profile-card" data-selected={selected}>
    <div className="tp-profile-heading">
      <strong className="tp-profile-name" title={profile.name}>{profile.name}</strong>
      <div className="tp-profile-actions">
        <button type="button" aria-label={`更新订阅 ${profile.name}`} title="更新订阅"
          aria-busy={status === 'busy'} disabled={disabled || status === 'busy'} onClick={() => void update()}>
          <IconRefresh size={15} className={status === 'busy' ? 'spin' : undefined} />
        </button>
        <button type="button" className="tp-profile-use" aria-label={`使用订阅 ${profile.name}`} title={selected ? '正在使用' : '使用订阅'}
          aria-pressed={selected} disabled={disabled || selected || status === 'busy'} onClick={onUse}>
          <IconCheck size={15} />
        </button>
      </div>
    </div>
    <div className="tp-profile-usage">
      <span>{info ? `已用 ${formatBytes(used)}` : '暂无用量信息'}</span>
      {total > 0 && <span>共 {formatBytes(total)}</span>}
    </div>
    {total > 0 && <div className="tp-profile-progress" data-warning={expired || ratio >= .9} role="progressbar"
      aria-label={`${profile.name} 用量`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
      <span style={{ width: `${ratio * 100}%` }} />
    </div>}
    <div className="tp-profile-meta">
      <span className={expired ? 'tp-profile-expired' : undefined}>{info?.expire ? `${formatExpire(info.expire)} ${expired ? '已到期' : '到期'}` : profile.sourceType === 'file' ? '本地配置' : info ? '不限期' : '到期信息未提供'}</span>
      <span role={status === 'error' ? 'alert' : status !== 'idle' ? 'status' : undefined} className={status === 'error' ? 'tp-profile-error' : undefined}>
        {status === 'busy' ? '更新中…' : status === 'error' ? '更新失败，可重试' : status === 'success' ? '已更新' : profile.updatedAt ? `${formatTime(profile.updatedAt)} 更新` : '尚未更新'}
      </span>
    </div>
  </article>;
}
