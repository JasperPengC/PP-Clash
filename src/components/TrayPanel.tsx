import { subscribeRuntimeDisplayStatus, type RuntimeDisplayStatus } from '../core/runtime-display-events';
import { useEffect, useRef, useState } from 'react';
import { NodeName } from './NodeName';
import { api, isTauri, previewMode, setMihomoBase, setMihomoSecret, type TrayActionValue, type TrayGroup, type TraySnapshot } from '../core/api';
import { formatSpeed } from '../core/format';
import { startPolling } from '../core/polling';
import { useTakeoverStatus } from '../core/use-takeover-status';
import { GITHUB_LATENCY_URL, groupLatencyTarget, latencyTestQuery, normalizeLatency, parseTargetLatencies } from '../core/latency';
import { Segmented, Toggle } from './ui';
import {
  IconCheck,
  IconChevronRight,
  IconChevronDown,
  IconDownload,
  IconGlobe,
  IconProfiles,
  IconOverview,
  IconPower,
  IconRefresh,
  IconSettings,
  IconTun,
  IconUpload,
} from './icons';

function stateLabel(s: TraySnapshot | null): string {
  if (!s) return '读取状态…';
  if (!s.running) return '未运行';
  if (s.tun) return 'TUN';
  if (s.sysProxy) return '系统代理';
  return '未接管';
}

function snapshotGroups(snapshot: TraySnapshot | null): TrayGroup[] {
  if (snapshot?.groups) return snapshot.groups;
  // 旧快照不知道策略类型，不能把它猜成手动选择器。
  return snapshot?.group ? [{ name: snapshot.group, type: '未知类型', manual: false,
    now: null, nodes: snapshot.nodes.slice(0, 7).map(node => ({ ...node, selected: false })), total: snapshot.nodes.length }] : [];
}

function viewedGroup(snapshot: TraySnapshot | null, name: string | null): TrayGroup | undefined {
  const groups = snapshotGroups(snapshot);
  return groups.find(group => group.name === name)
    ?? groups.find(group => group.name === snapshot?.group) ?? groups[0];
}

function policyCurrent(group: TrayGroup): string {
  if (group.type === 'LoadBalance') return '按连接分配 · 无唯一出口';
  if (group.type === 'Relay') return '旧 Relay 配置 · 转发能力未核验';
  if (!['Selector', 'URLTest', 'Fallback'].includes(group.type)) return '选择状态未知 · 只读';
  return group.now ? `当前选项：${group.now}` : '当前选项待确认';
}

export function TrayPanel() {
  const [snap, setSnap] = useState<TraySnapshot | null>(null);
  const [delays, setDelays] = useState<Record<string, number | null>>({});
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const latencyScope = useRef('');
  const testRequest = useRef(0);
  const testPending = useRef(false);
  const panelActive = useRef(true);
  const panelRevision = useRef(0);
  const latencyPool = useRef({ active: 0, waiting: [] as Array<() => void> });
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [browsedGroup, setBrowsedGroup] = useState<string | null>(null);
  const browseRef = useRef<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [runtimeDisplay, setRuntimeDisplay] = useState<RuntimeDisplayStatus>({ revision: 'initial', transitioning: isTauri });
  const takeover = useTakeoverStatus({
    active: panelActive.current && snap !== null,
    running: Boolean(snap?.running),
    sysProxy: Boolean(snap?.sysProxy),
    tun: Boolean(snap?.tun),
    revision: JSON.stringify([runtimeDisplay.revision, panelRevision.current, snap?.activeProfile, snap?.mode, snap?.controllerPort, snap?.controllerSecret]),
    transitioning: pending !== null || runtimeDisplay.transitioning || !snap,
  });

  const resetLatency = () => {
    testRequest.current += 1;
    testPending.current = false;
    setTesting(false);
    setTestError(null);
    setDelays({});
  };

  const resetPanelActivity = (active: boolean) => {
    panelActive.current = active;
    panelRevision.current += 1;
    resetLatency();
    setSnap(null);
  };

  useEffect(() => {
    if (!isTauri) return;
    return subscribeRuntimeDisplayStatus(status => {
      setRuntimeDisplay(status);
      // 下一次已有快照循环读回最新控制端；旧请求和旧参数同时失效。
      resetPanelActivity(panelActive.current);
    });
  }, []);

  useEffect(() => {
    if (!isTauri && !previewMode) return;
    let alive = true;
    const load = async () => {
      // 面板隐藏时不做无意义轮询
      if (!previewMode && (!panelActive.current || document.hidden || !document.hasFocus())) {
        if (panelActive.current) resetPanelActivity(false);
        return;
      }
      const revision = panelRevision.current;
      await api
        .traySnapshot()
        .then((v) => {
          if (alive && revision === panelRevision.current) {
            const current = viewedGroup(v, browseRef.current);
            const scope = JSON.stringify([v.activeProfile, current?.name, current?.type,
              current?.nodes.map(node => node.name), v.running, v.mode, v.controllerPort, v.controllerSecret]);
            if (scope !== latencyScope.current) {
              latencyScope.current = scope;
              resetLatency();
            }
            setMihomoBase(v.controllerPort);
            setMihomoSecret(v.controllerSecret);
            if (browseRef.current && current?.name !== browseRef.current) {
              browseRef.current = null;
              setBrowsedGroup(null);
            }
            setSnap(v);
          }
        })
        .catch(() => undefined);
    };
    const stop = startPolling(load, 900);
    const onBlur = () => { if (!previewMode) resetPanelActivity(false); };
    const onFocus = () => {
      if (previewMode) return;
      resetPanelActivity(!document.hidden && document.hasFocus());
    };
    const onVisibility = () => document.hidden ? onBlur() : onFocus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        resetPanelActivity(false);
        void api.trayAction('close');
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      testRequest.current += 1;
      stop();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const groups = snapshotGroups(snap);
  const currentGroup = viewedGroup(snap, browsedGroup);
  const visibleNodes = currentGroup ? [...currentGroup.nodes].sort((a, b) => Number(b.selected) - Number(a.selected)).slice(0, 7) : [];
  const manual = currentGroup?.type === 'Selector' && currentGroup.manual;

  const browse = (name: string) => {
    resetLatency();
    browseRef.current = name;
    setBrowsedGroup(name);
    // 浏览操作本地完成，下次相同快照不应使新测速失效。
    const current = viewedGroup(snap, name);
    latencyScope.current = JSON.stringify([snap?.activeProfile, current?.name, current?.type,
      current?.nodes.map(node => node.name), snap?.running, snap?.mode, snap?.controllerPort, snap?.controllerSecret]);
  };

  const act = (action: string, value?: TrayActionValue) => {
    if (action === 'profile') resetLatency();
    if (action === 'close' || action === 'open' || action === 'quit') resetPanelActivity(false);
    if (action === 'sysproxy' || action === 'tun') {
      setPending(action);
      window.setTimeout(() => setPending(null), 5000);
    }
    setActionError(null);
    void api.trayAction(action, value).catch(() => {
      if (panelActive.current) setActionError('操作未完成，请重试');
    });
  };

  const testGroup = async () => {
    if (!snap?.running || !currentGroup || !visibleNodes.length || profilesOpen || runtimeDisplay.transitioning || testPending.current
      || (!previewMode && (!panelActive.current || document.hidden || !document.hasFocus()))) return;
    testPending.current = true;
    const request = ++testRequest.current;
    const isCurrent = () => request === testRequest.current
      && (previewMode || (panelActive.current && !document.hidden && document.hasFocus()));
    setTesting(true);
    setTestError(null);
    const target = groupLatencyTarget(currentGroup.name);
    const results: Record<string, number | null> = {};
    const failures: string[] = [];
    const measure = async (name: string) => {
      // 新旧批次共用三个请求槽；已失效的排队节点不再发送请求。
      await new Promise<void>(resolve => {
        if (latencyPool.current.active < 3) {
          latencyPool.current.active += 1;
          resolve();
        } else latencyPool.current.waiting.push(resolve);
      });
      try {
        if (!isCurrent()) return;
        const path = `/proxies/${encodeURIComponent(name)}`;
        const raw = await api.mihomo('GET', `${path}/delay?${latencyTestQuery(target)}`) as { delay?: unknown } | null;
        if (!isCurrent()) return;
        let delay = normalizeLatency(raw?.delay);
        if (target === GITHUB_LATENCY_URL && delay !== null) {
          // expected=200 只更新 Alive；正数 delay 本身不代表 HTTP 状态匹配。
          const detail = await api.mihomo('GET', path) as { extra?: Record<string, { Alive?: boolean; alive?: boolean }> } | null;
          if (!isCurrent()) return;
          const state = detail?.extra?.[target];
          delay = (state?.Alive ?? state?.alive) === true ? parseTargetLatencies(detail)[target] ?? null : null;
        }
        results[name] = delay;
        if (delay === null) failures.push(name);
      } catch {
        if (isCurrent()) {
          results[name] = null;
          failures.push(name);
        }
      } finally {
        const next = latencyPool.current.waiting.shift();
        if (next) next();
        else latencyPool.current.active -= 1;
      }
    };
    try {
      await Promise.all(visibleNodes.map(node => measure(node.name)));
      if (!isCurrent()) return;
      setDelays(results);
      if (failures.length) setTestError(`${failures.length} 个节点测速失败：${failures.join('、')}`);
    } finally {
      if (request === testRequest.current) {
        testPending.current = false;
        setTesting(false);
      }
    }
  };

  const label = stateLabel(snap);
  const running = Boolean(snap?.running);
  const latencyTarget = groupLatencyTarget(currentGroup?.name ?? '');
  const latencyLabel = latencyTarget === GITHUB_LATENCY_URL ? 'GitHub 延迟' : '常规延迟';

  return (
    <div className="tp-root" onMouseDown={(event) => {
      if (event.target === event.currentTarget) act('close');
    }}>
      <div className="tp-card" data-visible={Boolean(snap)}>
        <div className="tp-head">
          <span className={`tp-dot${running ? ' on' : ''}`} />
          <span className="tp-brand">PP Clash</span>
          <span className={`tp-state${snap?.tun || snap?.sysProxy ? ' active' : ''}`}>{label}</span>
          <div className="spacer" />
          <button
            type="button"
            className="tp-icon"
            title="打开主界面"
            aria-label="打开主界面"
            onClick={() => act('open', 'overview')}
          >
            <IconChevronRight size={14} />
          </button>
        </div>

        <div className="tp-speeds" data-tray-section="speed" aria-label="实时速度">
          <div className="tp-speed-row tp-speed-up">
            <span className="tp-speed-label">
              <IconUpload size={12} />
              上传
            </span>
            <b className="tp-speed-value">{formatSpeed(snap?.up ?? 0)}</b>
          </div>
          <div className="tp-speed-row tp-speed-down">
            <span className="tp-speed-label">
              <IconDownload size={12} />
              下载
            </span>
            <b className="tp-speed-value">{formatSpeed(snap?.down ?? 0)}</b>
          </div>
        </div>

        <div className="tp-rows" data-tray-section="takeover" aria-label="流量接管">
          <div className="tp-row">
            <span className="tp-row-icon">
              <IconGlobe size={14} />
            </span>
            <span className="tp-row-copy">
              <span className="tp-row-label">系统代理</span>
              <span className="tp-row-subtitle" title={takeover.systemProxySubtitle}>{takeover.systemProxySubtitle}</span>
            </span>
            <Toggle
              on={Boolean(snap?.sysProxy)}
              busy={pending === 'sysproxy'}
              disabled={pending !== null}
              onChange={(v) => act('sysproxy', String(v))}
              label="系统代理"
            />
          </div>
          <div className="tp-row">
            <span className="tp-row-icon">
              <IconTun size={14} />
            </span>
            <span className="tp-row-copy">
              <span className="tp-row-label">TUN 模式</span>
              <span className="tp-row-subtitle" title={takeover.tunSubtitle}>{takeover.tunSubtitle}</span>
            </span>
            <Toggle
              on={Boolean(snap?.tun)}
              busy={pending === 'tun'}
              disabled={pending !== null}
              onChange={() => act('tun')}
              label="TUN 模式"
            />
          </div>
        </div>

        <div className="tp-mode" data-tray-section="mode">
          <Segmented
            options={[
              { value: 'rule', label: '规则' },
              { value: 'global', label: '全局' },
              { value: 'direct', label: '直连' },
            ]}
            value={(snap?.mode as 'rule' | 'global' | 'direct') ?? 'rule'}
            onChange={(v) => act('mode', v)}
            ariaLabel="出站模式"
          />
        </div>

        <div className="tp-node-head" data-tray-section="profile">
          <button
            type="button"
            className="tp-profile-trigger"
            onClick={() => { resetLatency(); setProfilesOpen((v) => !v); }}
            title="切换订阅"
            aria-expanded={profilesOpen}
            aria-controls={profilesOpen ? 'tray-profile-list' : undefined}
          >
            <IconProfiles size={13} />
            <span className="tp-profile-name">
              {snap?.profiles.find((p) => p.id === snap.activeProfile)?.name || '选择订阅'}
            </span>
            <IconChevronDown size={11} />
          </button>
          <div className="spacer" />
          <button
            type="button"
            className="tp-test"
            disabled={!snap?.running || !visibleNodes.length || profilesOpen || runtimeDisplay.transitioning || testing}
            title={`测速目标：${latencyTarget}`}
            onClick={() => void testGroup()}
          >
            {testing ? '测速中' : '测速'}
          </button>
        </div>

        {!profilesOpen && <>
          <div className="tp-policy" data-tray-section="group">
            <label className="tp-policy-picker">
              <span>策略</span>
              <select aria-label="浏览策略" value={currentGroup?.name ?? ''} disabled={!groups.length}
                onChange={event => browse(event.target.value)}>
                {groups.length ? groups.map(group => <option key={group.name} value={group.name}>{group.name}</option>)
                  : <option value="">暂无策略</option>}
              </select>
            </label>
            {currentGroup && <>
              <span className="tp-policy-type">{currentGroup.type}{manual ? ' · 手动选择' : ' · 只读'}</span>
              <div className="tp-policy-current" title={policyCurrent(currentGroup)}>{policyCurrent(currentGroup)}</div>
            </>}
          </div>
          <div className={`tp-latency-status${testError ? ' error' : ''}`} role="status" title={testError ?? latencyTarget}>
            {latencyLabel} · {testing ? '正在测速…' : testError ? '测速失败，可重试' : '点击测速更新'}
          </div>
        </>}

        {actionError && <div className="tp-action-error" role="alert">{actionError}</div>}

        {profilesOpen ? (
          <div className="tp-profile-list" id="tray-profile-list">
            {(snap?.profiles ?? []).map((p) => (
              <button
                key={p.id}
                type="button"
                className={`tp-profile-item${p.id === snap?.activeProfile ? ' selected' : ''}`}
                onClick={() => {
                  setProfilesOpen(false);
                  act('profile', p.id);
                }}
              >
                <span className="tp-node-item-name" title={p.name}>{p.name}</span>
                {p.id === snap?.activeProfile && <IconCheck size={12} />}
              </button>
            ))}
            {(snap?.profiles ?? []).length === 0 && (
              <div className="tp-node-empty">还没有订阅</div>
            )}
          </div>
        ) : (
          <div className="tp-node-list" data-tray-section="nodes" aria-label="策略候选">
            {visibleNodes.map((node) => {
              const delay = Object.prototype.hasOwnProperty.call(delays, node.name) ? delays[node.name] : node.delay ?? undefined;
              return (
                <button
                  key={node.name}
                  type="button"
                  className={`tp-node-item${node.selected ? ' selected' : ''}`}
                  disabled={!running || !manual || runtimeDisplay.transitioning}
                  aria-label={`${manual ? '选择' : '候选'} ${node.name}`}
                  aria-pressed={node.selected}
                  onClick={() => {
                    if (currentGroup && manual) act('node', { group: currentGroup.name, node: node.name });
                  }}
                >
                  <span className="tp-node-item-name" title={node.name}><NodeName name={node.name} /></span>
                  <span className="tp-node-item-delay" title={`测速目标：${latencyTarget}`}>
                    {testing ? '等待' : delay === null ? '失败' : delay === undefined ? '未测' : `${delay} ms`}
                  </span>
                  {node.selected && <IconCheck size={12} />}
                </button>
              );
            })}
            {visibleNodes.length === 0 && (
              <div className="tp-node-empty" role={snap?.groupsError ? 'alert' : undefined}>
                {snap?.groupsError ?? (!running ? '内核运行后显示策略' : currentGroup ? '此策略暂无候选' : '暂无可用策略')}
              </div>
            )}
          </div>
        )}

        {!profilesOpen && <button type="button" className="tp-all-nodes" onClick={() => act('open', 'proxies')}>
          <span>全部节点{currentGroup ? ` · ${currentGroup.total} 个候选` : ''}</span><IconChevronRight size={12} />
        </button>}

        <div className="tp-foot" data-tray-section="footer">
          <button type="button" onClick={() => act('open', 'settings')}>
            <IconSettings size={13} />
            设置
          </button>
          <button type="button" onClick={() => act('open', 'overview')}>
            <IconOverview size={13} />
            主界面
          </button>
          <div className="spacer" />
          <button type="button" className="tp-restart" onClick={() => act('restart')}>
            <IconRefresh size={13} />
            重启
          </button>
          <button type="button" className="tp-quit" onClick={() => act('quit')}>
            <IconPower size={13} />
            退出
          </button>
        </div>
      </div>
    </div>
  );
}
