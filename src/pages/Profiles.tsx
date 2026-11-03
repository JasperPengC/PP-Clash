import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { EmptyState, MiniSwitch, Pill, Select, Spinner } from '../components/ui';
import { IconAlert, IconFolder, IconImport, IconProfiles, IconRefresh, IconTrash } from '../components/icons';
import { useApp, type Profile } from '../store/app';
import { isTauri, previewMode } from '../core/api';
import { open } from '@tauri-apps/plugin-dialog';
import { countRealNodes, type TrafficInfo } from '../core/subscription';
import { daysUntil, formatBytes, formatExpire, formatTime } from '../core/format';

const AUTO_OPTIONS = (followHours: number | null) => [
  { value: 'auto', label: `跟随订阅（${followHours ?? 24}h）` },
  { value: '6', label: '每 6 小时' },
  { value: '12', label: '每 12 小时' },
  { value: '24', label: '每 24 小时' },
  { value: '48', label: '每 48 小时' },
  { value: 'off', label: '关闭自动更新' },
];

function QuotaCell({ info }: { info: TrafficInfo | null }) {
  if (!info) return <div className="sub-empty">暂无配额信息</div>;

  const used = Math.max(info.upload + info.download, 0);
  const total = Math.max(info.total, 0);
  const ratio = total > 0 ? Math.min(used / total, 1) : 0;
  const remaining = Math.max(total - used, 0);
  const tone = ratio >= 0.9 ? 'bad' : ratio >= 0.7 ? 'warn' : 'ok';
  const days = daysUntil(info.expire);
  const expired = days != null && days < 0;

  return (
    <div className="sub-quota">
      <div className="sub-quota-line">
        <span>
          已用 {formatBytes(used)}
          {total > 0 ? ` / ${formatBytes(total)}` : ''}
        </span>
        {total > 0 && <span>剩余 {formatBytes(remaining)}</span>}
      </div>
      {total > 0 && (
        <div className="progress sub-progress">
          <span className={`progress-fill ${tone}`} style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
      <div className="sub-quota-line sub-quota-sub">
        <span className={expired ? 'quota-expired' : undefined}>
          {info.expire > 0
            ? `${expired ? '已过期' : '到期'} ${formatExpire(info.expire)}${
                days != null && !expired ? `（剩 ${days} 天）` : ''
              }`
            : '不限期'}
        </span>
      </div>
    </div>
  );
}

function ProfileRow({
  profile,
  active,
  busy,
  confirming,
  nodeCount,
  refreshing,
  onActivate,
  onRefresh,
  onDelete,
  onUpdate,
  onMove,
  canMoveUp,
  canMoveDown,
  dragging,
  dropTarget,
  onDragHandle,
}: {
  profile: Profile;
  active: boolean;
  busy: boolean;
  confirming: boolean;
  nodeCount: number;
  refreshing: boolean;
  onActivate: () => void;
  onRefresh: () => void;
  onDelete: () => void;
  onUpdate: (patch: Partial<Profile>) => void;
  onMove: (dir: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onDragHandle: (e: ReactPointerEvent<HTMLSpanElement>) => void;
}) {
  const autoValue =
    profile.autoUpdateHours === 0
      ? 'off'
      : profile.autoUpdateHours == null
        ? 'auto'
        : String(profile.autoUpdateHours);

  return (
    <div
      className={`sub-row${active ? ' active' : ''}${dragging ? ' dragging' : ''}${
        dropTarget ? ' drop-target' : ''
      }`}
      data-profile-id={profile.id}
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!active) onActivate();
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !active) {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      <span
        className="drag-handle"
        title="拖拽排序"
        aria-hidden="true"
        onPointerDown={onDragHandle}
        onClick={(e) => e.stopPropagation()}
      >
        ⋮⋮
      </span>
      <div className="sub-main">
        <div className="sub-text">
          <div className="sub-name-line">
            <span className="sub-name" title={profile.name}>
              {profile.name}
            </span>
            {profile.sourceType === 'file' && <Pill>本地</Pill>}
            {active && <Pill tone="ok">当前</Pill>}
          </div>
          <div className="sub-meta">
            {nodeCount} 个节点 · 更新于 {formatTime(profile.updatedAt)}
          </div>
        </div>
      </div>

      <QuotaCell info={profile.userinfo} />

      <div className="sub-update" onClick={(e) => e.stopPropagation()}>
        <Select
          value={autoValue}
          options={AUTO_OPTIONS(profile.updateIntervalHours)}
          ariaLabel="自动更新间隔"
          onChange={(v) =>
            onUpdate({
              autoUpdateHours: v === 'auto' ? null : v === 'off' ? 0 : Number(v),
            })
          }
        />
        {profile.sourceType !== 'file' && (
          <>
            <span className="sub-proxy-label" title="更新订阅时使用本机代理">使用代理</span>
            <MiniSwitch
              on={Boolean(profile.useProxy)}
              onChange={(v) => onUpdate({ useProxy: v })}
              label="经代理更新"
            />
          </>
        )}
      </div>

      <div className="sub-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="icon-btn"
          title="上移"
          aria-label="上移订阅"
          disabled={busy || !canMoveUp}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="icon-btn"
          title="下移"
          aria-label="下移订阅"
          disabled={busy || !canMoveDown}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="icon-btn"
          title="更新订阅"
          aria-label="更新订阅"
          disabled={busy}
          onClick={onRefresh}
        >
          {refreshing ? <Spinner small /> : <IconRefresh size={14} />}
        </button>
        <button
          type="button"
          className={`icon-btn danger${confirming ? ' confirming' : ''}`}
          title={confirming ? '再点一次确认删除' : '删除订阅'}
          aria-label={confirming ? '确认删除订阅' : '删除订阅'}
          disabled={busy}
          onClick={onDelete}
        >
          {confirming ? <span className="t-micro">确认</span> : <IconTrash size={14} />}
        </button>
      </div>
    </div>
  );
}

export function ProfilesPage() {
  const profiles = useApp((s) => s.profiles);
  const activeId = useApp((s) => s.activeId);
  const importProfile = useApp((s) => s.importProfile);
  const importProfileFile = useApp((s) => s.importProfileFile);
  const activate = useApp((s) => s.activate);
  const removeProfile = useApp((s) => s.removeProfile);
  const refreshProfile = useApp((s) => s.refreshProfile);
  const updateProfile = useApp((s) => s.updateProfile);
  const moveProfile = useApp((s) => s.moveProfile);
  const reorderProfiles = useApp((s) => s.reorderProfiles);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragOverRef = useRef<string | null>(null);

  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el instanceof Element ? el.closest<HTMLElement>('[data-profile-id]') : null;
      const over = row?.dataset.profileId ?? null;
      dragOverRef.current = over;
      setDragOverId(over);
    };
    const onUp = () => {
      const over = dragOverRef.current;
      if (over && over !== dragId) reorderProfiles(dragId, over);
      dragOverRef.current = null;
      setDragOverId(null);
      setDragId(null);
    };
    const onCancel = () => {
      dragOverRef.current = null;
      setDragOverId(null);
      setDragId(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
    };
  }, [dragId, reorderProfiles]);
  const stats = useApp((s) => s.stats);
  const busy = useApp((s) => s.busy);
  const importing = useApp((s) => s.importing);
  const refreshingIds = useApp((s) => s.refreshingIds);

  const [url, setUrl] = useState('');
  const [proxyImport, setProxyImport] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);

  const nodeCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of profiles) out[p.id] = countRealNodes(p.raw);
    return out;
  }, [profiles]);

  const pickFile = async () => {
    if (!isTauri || importing) return;
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Clash / mihomo 配置', extensions: ['yaml', 'yml', 'json'] }],
      });
      if (typeof path === 'string' && path) await importProfileFile(path);
    } catch (e) {
      useApp.getState().notify('error', `选择文件失败：${String(e)}`);
    }
  };

  const submit = async () => {
    const v = url.trim();
    if (!v || importing) return;
    const before = useApp.getState().profiles.length;
    await importProfile(v, proxyImport);
    setUrl('');
    if (useApp.getState().profiles.length > before) {
      setProxyImport(false);
    }
  };

  const askDelete = (id: string) => {
    if (confirmId === id) {
      setConfirmId(null);
      void removeProfile(id);
      return;
    }
    setConfirmId(id);
    window.setTimeout(() => {
      setConfirmId((cur) => (cur === id ? null : cur));
    }, 3000);
  };

  const refreshAll = () => {
    const notify = useApp.getState().notify;
    setRefreshingAll(true);
    void Promise.all(profiles.map((p) => refreshProfile(p.id, true)))
      .then((results) => {
        if (results.every(Boolean)) notify('success', '所有订阅已更新');
        else notify('error', '部分订阅更新失败');
      })
      .finally(() => setRefreshingAll(false));
  };

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">订阅</h1>
          <div className="page-sub">
            {profiles.length > 0 ? `${profiles.length} 份订阅` : '还没有订阅'}
          </div>
        </div>
        <div className="page-actions">
          {profiles.length > 1 && (
            <button
              type="button"
              className="btn"
              disabled={refreshingAll}
              onClick={refreshAll}
            >
              {refreshingAll ? <Spinner small /> : <IconRefresh size={13} />}
              全部更新
            </button>
          )}
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner">
          {!isTauri && !previewMode && (
            <div className="banner warn">
              <IconAlert size={14} />
              <span>浏览器预览模式无法拉取订阅，请打开 PP Clash.app。</span>
            </div>
          )}

          <section className="card import-card">
            <div className="import-head">
              <span className="section-title">添加订阅</span>
              <span className="card-hint">Clash / mihomo 链接或本地文件</span>
            </div>
            <form
              className="row import-row"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <input
                className="input input-mono"
                style={{ flex: 1, minWidth: 0 }}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/api/v1/client/subscribe?token=…"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="订阅链接"
              />
              <label className="import-proxy">
                <span title="导入订阅时使用本机代理">使用代理</span>
                <MiniSwitch
                  on={proxyImport}
                  onChange={setProxyImport}
                  label="经代理导入订阅"
                />
              </label>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={importing || !url.trim()}
              >
                {importing ? (
                  <>
                    <Spinner small />
                    导入中
                  </>
                ) : (
                  <>
                    <IconImport size={13} />
                    导入
                  </>
                )}
              </button>
            </form>
            <div className="import-file-row">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={importing}
                onClick={() => void pickFile()}
              >
                <IconFolder size={13} />
                从文件导入
              </button>
              <span className="card-hint">.yaml / .yml / .json，最大 10MB</span>
            </div>
          </section>

          {profiles.length > 0 ? (
            <section className="card sub-table">
              <div className="sub-head">
                <span>订阅</span>
                <span>流量 / 到期</span>
                <span>自动更新 / 代理</span>
                <span className="sub-head-actions">操作</span>
              </div>
              {profiles.map((p, index) => (
                <ProfileRow
                  key={p.id}
                  onMove={(dir) => moveProfile(p.id, dir)}
                  canMoveUp={index > 0}
                  canMoveDown={index < profiles.length - 1}
                  profile={p}
                  active={p.id === activeId}
                  busy={busy}
                  confirming={confirmId === p.id}
                  nodeCount={nodeCounts[p.id] ?? 0}
                  refreshing={refreshingIds.includes(p.id)}
                  onActivate={() => void activate(p.id)}
                  onRefresh={() => void refreshProfile(p.id)}
                  onDelete={() => askDelete(p.id)}
                  onUpdate={(patch) => updateProfile(p.id, patch)}
                  dragging={dragId === p.id}
                  dropTarget={dragOverId === p.id && dragId !== p.id}
                  onDragHandle={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOverId(null);
                    setDragId(p.id);
                  }}
                />
              ))}
            </section>
          ) : (
            <section className="card">
              <EmptyState
                icon={<IconProfiles size={19} />}
                title="还没有订阅"
                desc="导入订阅链接。"
              />
            </section>
          )}

          {stats && (
            <section className="card">
              <div className="row" style={{ gap: 10 }}>
                <span className="section-title">订阅统计</span>
                <div className="spacer" />
              </div>
              <div className="stat-grid">
                {[
                  { label: '节点', value: stats.proxyCount },
                  { label: '分组', value: stats.groupCount },
                  { label: '规则', value: stats.ruleCount },
                  { label: '防护规则', value: stats.guardRuleCount },
                ].map((x) => (
                  <div key={x.label} className="stat-item">
                    <div className="stat-value">{x.value}</div>
                    <div className="stat-label">{x.label}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
