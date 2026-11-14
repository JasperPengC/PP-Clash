import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { EmptyState, MiniSwitch, Pill, Select, Spinner } from '../components/ui';
import { IconAlert, IconChevronRight, IconFolder, IconImport, IconProfiles, IconRefresh, IconTrash } from '../components/icons';
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

function profileSource(profile: Profile): string {
  if (profile.sourceType === 'file') return '本地配置';
  try { return new URL(profile.url).hostname; } catch { return '远程订阅'; }
}

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
      {total > 0 && <strong className="sub-quota-remaining">剩余 {formatBytes(remaining)}</strong>}
      <div className="sub-quota-line">
        <span>
          已用 {formatBytes(used)}
          {total > 0 ? ` / ${formatBytes(total)}` : ''}
        </span>
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

function ProfileEditor({ profile, busy, confirming, index, total, onUpdate, onMove, onDelete, onClose, onRefresh }: {
  profile: Profile; busy: boolean; confirming: boolean; index: number; total: number;
  onUpdate: (patch: Partial<Profile>) => void; onMove: (dir: -1 | 1) => void;
  onDelete: () => void; onClose: () => void; onRefresh: () => void;
}) {
  const [source, setSource] = useState(profile.url);
  const [hours, setHours] = useState(profile.autoUpdateHours ?? null);
  const [proxy, setProxy] = useState(Boolean(profile.useProxy));
  const [picking, setPicking] = useState(false);
  const [saved, setSaved] = useState(false);
  const sourceInput = useRef<HTMLInputElement>(null);
  const local = profile.sourceType === 'file';
  const changed = source.trim() !== profile.url || hours !== (profile.autoUpdateHours ?? null) || proxy !== Boolean(profile.useProxy);
  useEffect(() => { sourceInput.current?.focus(); }, []);

  const replaceFile = async () => {
    if (!isTauri || busy || picking) return;
    setPicking(true);
    try {
      const path = await open({ multiple: false, directory: false,
        filters: [{ name: 'Clash / mihomo 配置', extensions: ['yaml', 'yml', 'json'] }] });
      if (typeof path === 'string' && path) { setSource(path); setSaved(false); }
    } catch (error) {
      useApp.getState().notify('error', `选择文件失败：${String(error)}`);
    } finally { setPicking(false); }
  };

  return <form className="sub-editor" aria-label={`编辑 ${profile.name}`} onKeyDown={event => {
    if (event.key === 'Escape' && !picking) { event.preventDefault(); onClose(); }
  }} onSubmit={event => {
    event.preventDefault();
    if (busy || picking || !source.trim()) return;
    onUpdate({ url: source.trim(), autoUpdateHours: hours, useProxy: proxy });
    setSaved(true);
  }}>
    <div className="sub-editor-heading"><h3>编辑订阅</h3><span>{local ? '本地配置' : '远程订阅'}</span></div>
    <label className="sub-editor-field"><span>{local ? '本地文件' : '订阅 URL'}</span>
      <div className="sub-source-field">
        <input ref={sourceInput} className="input" type={local ? 'text' : 'url'} required
          pattern={local ? undefined : 'https?://.+'} readOnly={local} disabled={busy || picking}
          aria-label={local ? '本地文件路径' : '订阅 URL'} value={source} spellCheck={false}
          onChange={event => { setSource(event.target.value); setSaved(false); }} />
        {local && <button type="button" className="btn" disabled={!isTauri || busy || picking} onClick={() => void replaceFile()}>
          <IconFolder size={14} />{picking ? '选择中…' : '更换文件'}
        </button>}
      </div>
    </label>
    <div className="sub-editor-settings">
      <div className="sub-editor-field"><span>自动更新间隔</span><Select disabled={busy || picking}
        value={hours === 0 ? 'off' : hours == null ? 'auto' : String(hours)}
        options={AUTO_OPTIONS(profile.updateIntervalHours)} ariaLabel="自动更新间隔"
        onChange={value => { setHours(value === 'auto' ? null : value === 'off' ? 0 : Number(value)); setSaved(false); }} />
      </div>
      {!local && <div className="sub-proxy-control"><span>使用代理更新</span>
        <MiniSwitch on={proxy} disabled={busy || picking} label="经代理更新" onChange={value => { setProxy(value); setSaved(false); }} />
      </div>}
    </div>
    <p className="sub-editor-hint">保存来源后点击更新订阅，验证通过后替换配置；更新失败会保留最后成功的内容。</p>
    <div className="sub-editor-controls">
      <button type="submit" className="btn btn-primary" disabled={busy || picking || !source.trim() || !changed}>保存修改</button>
      <button type="button" className="btn" disabled={busy || picking || changed} onClick={onRefresh}><IconRefresh size={14} />更新订阅</button>
      <button type="button" className="btn btn-ghost" disabled={picking} onClick={onClose}>取消编辑</button>
      {saved && <span role="status" className="sub-editor-saved">修改已保存</span>}
    </div>
    <div className="sub-editor-manage">
      <div className="sub-order-control"><span>顺序 {index + 1} / {total}</span>
        <button type="button" className="icon-btn" aria-label="上移订阅" title="上移订阅" disabled={busy || picking || index === 0} onClick={() => onMove(-1)}><IconChevronRight size={14} className="sub-move-up" /></button>
        <button type="button" className="icon-btn" aria-label="下移订阅" title="下移订阅" disabled={busy || picking || index === total - 1} onClick={() => onMove(1)}><IconChevronRight size={14} className="sub-move-down" /></button>
        <span className="sub-drag-hint">也可拖动卡片排序</span>
      </div>
      <button type="button" className="btn btn-ghost danger" aria-label={confirming ? '确认删除订阅' : '删除订阅'} disabled={busy || picking} onClick={onDelete}>
        <IconTrash size={14} />{confirming ? '确认删除订阅' : '删除订阅'}
      </button>
      {confirming && <span className="sub-delete-warning" role="status">{profile.id === useApp.getState().activeId ? '删除当前订阅会断开连接，再次点击确认。' : '再次点击确认删除。'}</span>}
    </div>
  </form>;
}

function ProfileCard({ profile, active, busy, confirming, nodeCount, refreshing, refreshError,
  editing, editMode, index, total, status, statusTone, onActivate, onRefresh, onDelete, onUpdate,
  onMove, onEdit, onClose, dragging, dropTarget, onDragHandle }: {
  profile: Profile; active: boolean; busy: boolean; confirming: boolean; nodeCount: number;
  refreshing: boolean; refreshError?: string; editing: boolean; editMode: boolean;
  index: number; total: number; status: string; statusTone: 'ok' | 'warn' | 'bad' | 'neutral';
  onActivate: () => void; onRefresh: () => void; onDelete: () => void;
  onUpdate: (patch: Partial<Profile>) => void; onMove: (dir: -1 | 1) => void;
  onEdit: () => void; onClose: () => void; dragging: boolean; dropTarget: boolean;
  onDragHandle: (e: ReactPointerEvent<HTMLSpanElement>) => void;
}) {
  const editButton = useRef<HTMLButtonElement>(null);
  const interval = profile.autoUpdateHours ?? profile.updateIntervalHours ?? 24;
  return <section className={`card sub-card${active ? ' sub-hero' : ''}${editing ? ' editing' : ''}${editMode ? ' edit-mode' : ''}${dragging ? ' dragging' : ''}${dropTarget ? ' drop-target' : ''}`}
    data-profile-id={profile.id} aria-label={active ? '当前订阅' : `订阅 ${profile.name}`}>
    {editMode && <span className="drag-handle" title="拖拽排序" aria-hidden="true" onPointerDown={event => { if (!busy) onDragHandle(event); }}>
      <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor" aria-hidden="true">
        {[5, 9, 13].map(y => <g key={y}><circle cx="4" cy={y} r=".8" /><circle cx="8" cy={y} r=".8" /></g>)}
      </svg>
    </span>}
    <div className="sub-card-heading">
      <span className="sub-profile-symbol" aria-hidden="true">{profile.sourceType === 'file' ? <IconFolder size={22} /> : <IconProfiles size={22} />}</span>
      <div className="sub-main"><h2 className="sub-name" title={profile.name}>{profile.name}</h2>
        <div className="sub-meta">{active && '当前使用 · '}{nodeCount} 个节点 · {refreshing ? '正在更新…' : `更新于 ${formatTime(profile.updatedAt)}`}</div>
        <div className="sub-source">{profileSource(profile)}</div>
      </div>
    </div>
    {active && <div className="sub-chips"><Pill tone={statusTone}>{status}</Pill>
      <Pill>{interval === 0 ? '自动更新已关闭' : `每 ${interval} 小时更新`}</Pill>
      {profile.sourceType !== 'file' && profile.useProxy && <Pill>经代理更新</Pill>}
    </div>}
    <QuotaCell info={profile.userinfo} />
    {refreshError && <div className="sub-update-error" role="status"><IconAlert size={14} /><span>{refreshError}</span></div>}
    <div className="sub-card-actions">
      {!active && <Pill>{profile.sourceType === 'file' ? '本地配置' : '备用'}</Pill>}
      {active && <button type="button" className="btn btn-primary" disabled={busy} onClick={onRefresh}>
        {refreshing ? <Spinner small /> : <IconRefresh size={14} />}立即更新
      </button>}
      <button ref={editButton} type="button" className="btn" aria-expanded={editing} aria-controls={`profile-edit-${profile.id}`}
        disabled={busy} onClick={onEdit}>{active ? '编辑订阅' : '编辑'}</button>
      {!active && <button type="button" className="btn sub-switch" disabled={busy} aria-label={`切换使用 ${profile.name}`} onClick={onActivate}>切换使用</button>}
    </div>
    {editing && <div id={`profile-edit-${profile.id}`} className="sub-editor-wrap"><ProfileEditor profile={profile} busy={busy}
      confirming={confirming} index={index} total={total} onUpdate={onUpdate} onMove={onMove} onDelete={onDelete}
      onRefresh={onRefresh} onClose={() => { onClose(); editButton.current?.focus(); }} /></div>}
  </section>;
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
  const activating = useApp(s => s.activatingProfile);
  const importing = useApp((s) => s.importing);
  const refreshingIds = useApp((s) => s.refreshingIds);
  const refreshErrors = useApp((s) => s.profileRefreshErrors);
  const kernelPhase = useApp(s => s.kernelPhase);
  const kernelError = useApp(s => s.kernelError);
  const transition = useApp(s => s.runtimeConfigTransition);

  const [url, setUrl] = useState('');
  const [proxyImport, setProxyImport] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const globalBusy = activating || importing || transition || kernelPhase === 'starting' || kernelPhase === 'stopping';
  const manageBusy = globalBusy || refreshingIds.length > 0;
  const activeProfile = profiles.find(profile => profile.id === activeId);
  const status = activating || transition ? '正在切换配置' : kernelPhase === 'failed' ? '连接失败'
    : kernelPhase === 'running' ? kernelError ? '运行状态未确认' : '运行中' : kernelPhase === 'starting' ? '启动中'
      : kernelPhase === 'stopping' ? '停止中' : '未连接';
  const statusTone = kernelError || kernelPhase === 'failed' ? 'bad' : kernelPhase === 'running' && !activating && !transition ? 'ok'
    : globalBusy ? 'warn' : 'neutral';

  useEffect(() => {
    if (editingId && !profiles.some(profile => profile.id === editingId)) setEditingId(null);
  }, [profiles, editingId]);
  useEffect(() => {
    if (manageBusy || !editingId) { setDragId(null); setDragOverId(null); dragOverRef.current = null; }
  }, [manageBusy, editingId]);

  const nodeCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of profiles) out[p.id] = countRealNodes(p.raw);
    return out;
  }, [profiles]);

  const pickFile = async () => {
    if (!isTauri || globalBusy) return;
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
    if (!v || globalBusy) return;
    const ok = await importProfile(v, proxyImport);
    if (ok) {
      setUrl('');
      setProxyImport(false);
      setAdding(false);
    }
  };

  const askDelete = (id: string) => {
    if (manageBusy) return;
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
    if (manageBusy || refreshingAll) return;
    const notify = useApp.getState().notify;
    setRefreshingAll(true);
    void Promise.all(profiles.map((p) => refreshProfile(p.id, true)))
      .then((results) => {
        if (results.every(Boolean)) notify('success', '所有订阅已更新');
        else notify('error', '部分订阅更新失败');
      })
      .finally(() => setRefreshingAll(false));
  };

  const renderProfile = (profile: Profile) => <ProfileCard key={profile.id} profile={profile}
    active={profile.id === activeId} busy={manageBusy} confirming={confirmId === profile.id}
    nodeCount={nodeCounts[profile.id] ?? 0} refreshing={refreshingIds.includes(profile.id)} refreshError={refreshErrors[profile.id]}
    editing={editingId === profile.id} editMode={editingId !== null} index={profiles.indexOf(profile)} total={profiles.length}
    status={status} statusTone={statusTone} onActivate={() => { if (!manageBusy) void activate(profile.id); }}
    onRefresh={() => { if (!manageBusy) void refreshProfile(profile.id); }} onDelete={() => askDelete(profile.id)}
    onUpdate={patch => { if (!manageBusy) updateProfile(profile.id, patch); }}
    onMove={dir => { if (!manageBusy) moveProfile(profile.id, dir); }} onEdit={() => {
      setEditingId(editingId === profile.id ? null : profile.id); setConfirmId(null); setAdding(false);
    }} onClose={() => { setEditingId(null); setConfirmId(null); }} dragging={dragId === profile.id}
    dropTarget={dragOverId === profile.id && dragId !== profile.id} onDragHandle={event => {
      event.preventDefault(); event.stopPropagation(); setDragOverId(null); setDragId(profile.id);
    }} />;

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">订阅</h1>
          <div className="page-sub">
            {profiles.length > 0 ? `${profiles.length} 份订阅 · ${Object.values(nodeCounts).reduce((sum, count) => sum + count, 0)} 个节点` : '还没有订阅'}
          </div>
        </div>
        <div className="page-actions">
          {profiles.length > 1 && (
            <button
              type="button"
              className="btn"
              disabled={manageBusy || refreshingAll}
              onClick={refreshAll}
            >
              {refreshingAll ? <Spinner small /> : <IconRefresh size={13} />}
              全部更新
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={globalBusy} aria-expanded={adding || profiles.length === 0}
            onClick={() => { setAdding(!adding); setEditingId(null); setConfirmId(null); }}>添加订阅</button>
        </div>
      </header>

      <div className="page-scroll profiles-scroll">
        <div className="page-inner profiles-page">
          {!isTauri && !previewMode && (
            <div className="banner warn">
              <IconAlert size={14} />
              <span>浏览器预览模式无法拉取订阅，请打开 PP Clash.app。</span>
            </div>
          )}

          {activeProfile && renderProfile(activeProfile)}

          {(adding || profiles.length === 0) && <section className="card import-card" aria-label="添加订阅">
            <div className="import-head">
              <div className="import-heading">
                <h2 className="section-title">添加订阅</h2>
                <span className="card-hint">导入 Clash / mihomo 订阅链接或本地配置</span>
              </div>
              <div className="spacer" />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!isTauri || globalBusy}
                onClick={() => void pickFile()}
              >
                <IconFolder size={13} />
                从文件导入
              </button>
            </div>
            <form
              className="import-row"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <input
                className="input input-mono"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="粘贴订阅链接（https://…）"
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
                className="btn btn-primary import-submit"
                disabled={globalBusy || !url.trim()}
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
            <div className="import-foot">
              <span className="card-hint">支持 .yaml / .yml / .json，最大 10MB</span>
            </div>
          </section>}

          {profiles.length > 0 ? (
            <section className="sub-list" aria-label="订阅列表">
              <div className="sub-list-heading">
                <h2 className="section-title">{activeProfile ? '其他订阅' : '我的订阅'}</h2>
                <span>{editingId ? '编辑模式 · 拖动卡片或使用详情中的箭头排序' : '编辑订阅，或切换使用'}</span>
              </div>
              <div className="sub-card-flow">
              {profiles.filter(profile => profile.id !== activeId).map(renderProfile)}
              <button type="button" className="card sub-add-card" disabled={globalBusy} onClick={() => {
                setAdding(true); setEditingId(null); setConfirmId(null);
              }}><span aria-hidden="true">＋</span><span>添加订阅或本地配置</span></button>
              </div>
            </section>
          ) : (
            <section className="card">
              <EmptyState
                icon={<IconProfiles size={19} />}
                title="还没有订阅"
                desc="支持订阅链接和本地配置文件"
              />
            </section>
          )}

          {stats && (
            <section className="profiles-stats" aria-label="当前配置统计">
              <span>当前配置</span>
                {[
                  { label: '节点', value: stats.proxyCount },
                  { label: '分组', value: stats.groupCount },
                  { label: '规则', value: stats.ruleCount },
                  { label: '防护规则', value: stats.guardRuleCount },
                ].map((x) => (
                  <span key={x.label}><strong>{x.value}</strong> {x.label}</span>
                ))}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
