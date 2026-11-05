import { useApp } from '../store/app';
import { APP_VERSION } from '../core/update';
import { Spinner } from './ui';

/**
 * 默认是低调的纯文本版本号；悬浮时变成胶囊，并提示可检查更新。
 * 不建议在版本号前加 v，避免和 GitHub tag 混淆。
 */
export function VersionBadge({ className = '' }: { className?: string }) {
  const checking = useApp((s) => s.checkingUpdate);
  const updateInfo = useApp((s) => s.updateInfo);

  return (
    <button
      type="button"
      className={`version-badge${updateInfo ? ' has-update' : ''}${className ? ` ${className}` : ''}`}
      data-tip={updateInfo ? `发现新版本 ${updateInfo.version}` : '检查更新'}
      aria-label={updateInfo ? `发现新版本 ${updateInfo.version}` : '检查更新'}
      disabled={checking}
      onClick={() => void useApp.getState().checkUpdate(false)}
    >
      {checking ? <Spinner small /> : <span>{APP_VERSION}</span>}
      {updateInfo && <i className="version-dot" aria-hidden="true" />}
    </button>
  );
}
