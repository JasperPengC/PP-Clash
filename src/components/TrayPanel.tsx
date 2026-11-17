import { subscribeRuntimeDisplayStatus, type RuntimeDisplayStatus } from '../core/runtime-display-events';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { BrandCat } from './BrandCat';
import { NodeName } from './NodeName';
import { api, isTauri, previewMode, setMihomoBase, setMihomoSecret, type TrayActionValue, type TrayGroup, type TraySnapshot } from '../core/api';
import { formatSpeed } from '../core/format';
import { createActivityPolling } from '../core/polling';
import { useTakeoverStatus } from '../core/use-takeover-status';
import { GITHUB_LATENCY_URL, groupLatencyTarget, latencyTestQuery, normalizeLatency, parseTargetLatencies } from '../core/latency';
import { Segmented, Toggle } from './ui';
import { VirtualList } from './VirtualList';
import { resolveEffectiveGroup } from '../core/effective-group';
import { isInfoNode } from '../core/subscription';
import { TrayProfileCard } from './TrayProfileCard';
import {
  IconCheck,
  IconDownload,
  IconProfiles,
  IconOverview,
  IconPower,
  IconBolt,
  IconRestart,
  IconSettings,
  IconUpload,
} from './icons';

function stateLabel(s: TraySnapshot | null): string {
  if (!s) return '读取状态…';
  if (!s.running) return '未运行';
  if (s.tun) return 'TUN';
  if (s.sysProxy) return 'PROXY';
  return '未接管';
}

function snapshotGroups(snapshot: TraySnapshot | null): TrayGroup[] {
  if (snapshot?.groups) return snapshot.groups;
  // 旧快照不知道策略类型，不能把它猜成手动选择器。
  return snapshot?.group ? [{ name: snapshot.group, type: '未知类型', manual: false,
    now: null, nodes: snapshot.nodes.map(node => ({ ...node, selected: false })), total: snapshot.nodes.length }] : [];
}

function effectiveGroup(snapshot: TraySnapshot | null): TrayGroup | undefined {
  const groups = snapshotGroups(snapshot);
  const primary = snapshot?.mode === 'global' && groups.some(group => group.name === 'GLOBAL') ? 'GLOBAL' : snapshot?.group;
  return resolveEffectiveGroup(groups, primary ?? groups[0]?.name ?? '') ?? groups[0];
}

function policyCurrent(group: TrayGroup): string {
  if (group.type === 'LoadBalance') return '按连接分配 · 无唯一出口';
  if (group.type === 'Relay') return '旧 Relay 配置 · 转发能力未核验';
  if (!['Selector', 'URLTest', 'Fallback'].includes(group.type)) return '选择状态未知 · 只读';
  return group.now ? `当前选项：${group.now}` : '当前选项待确认';
}

function policyLabel(type: string): string {
  return ({ Selector: '手动选择', URLTest: '自动优选', Fallback: '故障转移',
    LoadBalance: '负载均衡', Relay: '链式代理' } as Record<string, string>)[type] ?? '未知策略';
}

function TraySpeed({ value }: { value: number }) {
  const [number, unit] = formatSpeed(value).split(' ');
  return <span className="tp-speed-value"><b>{number}</b><span>{unit}</span></span>;
}

// 速度只更新这块小区域，避免每秒协调整个候选列表。
const TrayTraffic = memo(function TrayTraffic({ active, revision }: { active: boolean; revision: number }) {
  const [rates, setRates] = useState<[number, number]>([0, 0]);
  const polling = useRef<ReturnType<typeof createActivityPolling> | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    let alive = true;
    const controller = createActivityPolling(async () => {
      const revision = epoch.current;
      const value = await api.trafficRates();
      if (alive && revision === epoch.current) setRates(previous =>
        previous[0] === value[0] && previous[1] === value[1] ? previous : value);
    }, 900);
    polling.current = controller;
    return () => { alive = false; controller.dispose(); polling.current = null; };
  }, []);
  useEffect(() => {
    epoch.current++;
    if (active) { polling.current?.pause(); polling.current?.resume(); }
    else polling.current?.pause();
  }, [active, revision]);
  return <div className="tp-speeds" data-tray-section="speed" aria-label="实时速度">
    <div className="tp-speed-row tp-speed-up"><span className="tp-speed-label"><IconUpload size={12} />上传</span><TraySpeed value={rates[0]} /></div>
    <div className="tp-speed-row tp-speed-down"><span className="tp-speed-label"><IconDownload size={12} />下载</span><TraySpeed value={rates[1]} /></div>
  </div>;
});

export function TrayPanel() {
  const [snap, setSnap] = useState<TraySnapshot | null>(null);
  const [delays, setDelays] = useState<Record<string, number | null>>({});
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const latencyScope = useRef('');
  const testRequest = useRef(0);
  const testPending = useRef(false);
  const [active, setActive] = useState(previewMode || (!document.hidden && document.hasFocus()));
  const panelActive = useRef(active);
  const [fresh, setFresh] = useState(false);
  const snapshotFresh = useRef(false);
  const polling = useRef<ReturnType<typeof createActivityPolling> | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const panelRevision = useRef(0);
  const latencyPool = useRef({ active: 0, waiting: [] as Array<(acquired: boolean) => void> });
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [runtimeDisplay, setRuntimeDisplay] = useState<RuntimeDisplayStatus>({ revision: 'initial', transitioning: isTauri });
  const takeover = useTakeoverStatus({
    active: active && fresh,
    running: Boolean(snap?.running),
    sysProxy: Boolean(snap?.sysProxy),
    tun: Boolean(snap?.tun),
    revision: JSON.stringify([runtimeDisplay.revision, panelRevision.current, snap?.activeProfile, snap?.mode, snap?.controllerPort, snap?.controllerSecret]),
    transitioning: pending !== null || runtimeDisplay.transitioning || !fresh,
  });

  const resetLatency = () => {
    testRequest.current += 1;
    latencyPool.current.waiting.splice(0).forEach(resolve => resolve(false));
    testPending.current = false;
    setTesting(false);
    setTestError(null);
    setDelays({});
  };

  const resetPanelActivity = (active: boolean) => {
    panelActive.current = active;
    setActive(active);
    panelRevision.current += 1;
    snapshotFresh.current = false;
    setFresh(false);
    // 取消未完成测速，保留同一配置下已完成的结果与 DOM。
    testRequest.current += 1;
    latencyPool.current.waiting.splice(0).forEach(resolve => resolve(false));
    testPending.current = false;
    setTesting(false);
    setTestError(null);
    clearTimeout(pendingTimer.current);
    pendingTimer.current = undefined;
    setPending(null);
    if (active) { polling.current?.pause(); polling.current?.resume(); }
    else polling.current?.pause();
  };

  useEffect(() => {
    if (!isTauri) return;
    return subscribeRuntimeDisplayStatus(status => {
      setRuntimeDisplay(status);
      if (!polling.current) return;
      // 下一次已有快照循环读回最新控制端；旧请求和旧参数同时失效。
      resetPanelActivity(panelActive.current);
      resetLatency();
    });
  }, []);

  useEffect(() => {
    if (!isTauri && !previewMode) return;
    let alive = true;
    mounted.current = true;
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
          if (alive && panelActive.current && revision === panelRevision.current) {
            const current = effectiveGroup(v);
            const scope = JSON.stringify([v.activeProfile, current?.name, current?.type,
              current?.nodes.map(node => node.name), v.running, v.mode, v.controllerPort, v.controllerSecret]);
            if (scope !== latencyScope.current) {
              latencyScope.current = scope;
              resetLatency();
            }
            setMihomoBase(v.controllerPort);
            setMihomoSecret(v.controllerSecret);
            setSnap(v);
            snapshotFresh.current = true;
            setFresh(true);
          }
        })
        .catch(() => undefined);
    };
    const controller = createActivityPolling(load, 3000);
    polling.current = controller;
    if (panelActive.current) controller.resume();
    const onBlur = () => { if (!previewMode && panelActive.current) resetPanelActivity(false); };
    const onFocus = () => {
      if (previewMode) return;
      const next = !document.hidden && document.hasFocus();
      if (next !== panelActive.current) resetPanelActivity(next);
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
      mounted.current = false;
      testRequest.current += 1;
      latencyPool.current.waiting.splice(0).forEach(resolve => resolve(false));
      controller.dispose();
      polling.current = null;
      clearTimeout(pendingTimer.current);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const currentGroup = useMemo(() => effectiveGroup(snap), [snap]);
  const groupNodes = useMemo(() => currentGroup ? currentGroup.nodes.filter(node => !isInfoNode(node.name)).sort((a, b) => {
    if (a.selected !== b.selected) return Number(b.selected) - Number(a.selected);
    const delay = (node: typeof a) => Object.prototype.hasOwnProperty.call(delays, node.name) ? delays[node.name] : node.delay;
    return (delay(a) ?? Number.MAX_SAFE_INTEGER) - (delay(b) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);
  }) : [], [currentGroup, delays]);
  const manual = currentGroup?.type === 'Selector' && currentGroup.manual;

  const act = (action: string, value?: TrayActionValue) => {
    if (!['close', 'open', 'quit', 'restart'].includes(action)
      && (!panelActive.current || !snapshotFresh.current || runtimeDisplay.transitioning)) return;
    if (action === 'profile') resetLatency();
    if (action === 'close' || action === 'open' || action === 'quit') resetPanelActivity(false);
    if (action === 'sysproxy' || action === 'tun') {
      setPending(action);
      clearTimeout(pendingTimer.current);
      pendingTimer.current = setTimeout(() => {
        pendingTimer.current = undefined;
        if (mounted.current && panelActive.current) setPending(null);
      }, 5000);
    }
    setActionError(null);
    const revision = panelRevision.current;
    void api.trayAction(action, value).then(() => {
      if (mounted.current && revision === panelRevision.current) polling.current?.refresh();
    }).catch(() => {
      if (mounted.current && panelActive.current && revision === panelRevision.current) setActionError('操作未完成，请重试');
    });
  };

  const testGroup = async () => {
    if (!snapshotFresh.current || !snap?.running || !currentGroup || !groupNodes.length || profilesOpen || runtimeDisplay.transitioning || testPending.current
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
      const acquired = await new Promise<boolean>(resolve => {
        if (latencyPool.current.active < 3) {
          latencyPool.current.active += 1;
          resolve(true);
        } else latencyPool.current.waiting.push(resolve);
      });
      if (!acquired) return;
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
        if (next) next(true);
        else latencyPool.current.active -= 1;
      }
    };
    try {
      let next = 0;
      // 每批只有三个工作协程；长列表不为全部节点同时创建排队请求。
      await Promise.all(Array.from({ length: Math.min(3, groupNodes.length) }, async () => {
        while (isCurrent() && next < groupNodes.length) await measure(groupNodes[next++].name);
      }));
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
    <div className="tp-root" onContextMenu={event => event.preventDefault()} onMouseDown={(event) => {
      if (event.target === event.currentTarget) act('close');
    }}>
      <div className="tp-card" data-visible={Boolean(snap)}>
        <div className="tp-head">
          <button type="button" className="tp-brand-button" aria-label="PP Clash · 打开主界面" title="打开主界面" onClick={() => act('open', 'overview')}>
            <BrandCat size={24} /><span className="tp-brand">PP Clash</span>
          </button>
          <div className="spacer" />
          <span className={`tp-state${running && (snap?.tun || snap?.sysProxy) ? ' active' : ''}`}>
            {label}<span className={`tp-dot${running && (snap?.tun || snap?.sysProxy) ? ' on' : ''}`} />
          </span>
        </div>

        <TrayTraffic active={active} revision={panelRevision.current} />

        <div className="tp-rows" data-tray-section="takeover" aria-label="流量接管">
          <div className="tp-row">
            <span className="tp-row-copy">
              <span className="tp-row-label">系统代理</span>
              <span className="tp-row-subtitle" title={takeover.systemProxySubtitle}>{takeover.systemProxySubtitle}</span>
            </span>
            <Toggle
              on={Boolean(snap?.sysProxy)}
              busy={pending === 'sysproxy'}
              disabled={!fresh || runtimeDisplay.transitioning || pending !== null}
              onChange={(v) => act('sysproxy', String(v))}
              label="系统代理"
            />
          </div>
          <div className="tp-row">
            <span className="tp-row-copy">
              <span className="tp-row-label">TUN 模式</span>
              <span className="tp-row-subtitle" title={takeover.tunSubtitle}>{takeover.tunSubtitle}</span>
            </span>
            <Toggle
              on={Boolean(snap?.tun)}
              busy={pending === 'tun'}
              disabled={!fresh || runtimeDisplay.transitioning || pending !== null}
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
            disabled={!fresh || runtimeDisplay.transitioning}
          />
        </div>

        <div className="tp-policy" data-tray-section="group">
          <span className="tp-current-group" title={!profilesOpen && currentGroup ? `${currentGroup.name} · ${policyLabel(currentGroup.type)} · ${policyCurrent(currentGroup)}` : undefined}>
            {profilesOpen ? '切换订阅' : currentGroup?.name ?? '暂无分组'}
          </span>
          <span className="tp-group-count">{profilesOpen ? `${snap?.profiles.length ?? 0} 份` : `${groupNodes.length} 个节点`}</span>
          {!profilesOpen && <button type="button" className="tp-icon tp-test" aria-label={testing ? '正在测速' : '测试当前分组延迟'}
            disabled={!fresh || !snap?.running || !groupNodes.length || runtimeDisplay.transitioning || testing}
            title={`${groupNodes.length} 个节点 · ${latencyLabel} · ${latencyTarget}`} onClick={() => void testGroup()}>
            <IconBolt size={16} />
          </button>}
        </div>
        {(testing || testError) && <div className={`tp-latency-status${testError ? ' error' : ''}`} role="status" title={testError ?? latencyTarget}>
          {testing ? '正在测速…' : '测速失败，可重试'}
        </div>}

        {actionError && <div className="tp-action-error" role="alert">{actionError}</div>}

        {profilesOpen ? (
          <div className="tp-profile-list" id="tray-profile-list">
            {(snap?.profiles ?? []).map((p) => (
              <TrayProfileCard key={p.id} profile={p} selected={p.id === snap?.activeProfile}
                disabled={!active || !fresh || runtimeDisplay.transitioning}
                onUse={() => {
                  setProfilesOpen(false);
                  act('profile', p.id);
                }}
                onRefresh={async () => {
                  if (!panelActive.current || !snapshotFresh.current || runtimeDisplay.transitioning) throw new Error('面板状态待确认');
                  await api.trayAction('refresh-profile', p.id);
                  if (mounted.current && panelActive.current) polling.current?.refresh();
                }} />
            ))}
            {(snap?.profiles ?? []).length === 0 && (
              <div className="tp-node-empty">还没有订阅</div>
            )}
          </div>
        ) : groupNodes.length > 0 ? (
          <VirtualList className="tp-node-list" label="当前分组节点" items={groupNodes} rowHeight={38} maxHeight={360}
            resetKey={`${snap?.activeProfile}:${currentGroup?.name}`} itemKey={node => node.name} renderItem={node => {
              const delay = Object.prototype.hasOwnProperty.call(delays, node.name) ? delays[node.name] : node.delay ?? undefined;
              return (
                <button
                  key={node.name}
                  type="button"
                  className={`tp-node-item${node.selected ? ' selected' : ''}`}
                  disabled={!fresh || !running || !manual || runtimeDisplay.transitioning}
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
                  <span className="tp-node-check">{node.selected && <IconCheck size={12} />}</span>
                </button>
              );
            }} />
        ) : null}
        {!profilesOpen && groupNodes.length === 0 && <div className="tp-node-empty" role={snap?.groupsError ? 'alert' : undefined}>
          {snap?.groupsError ?? (!running ? '内核运行后显示策略' : currentGroup ? '此分组暂无节点' : '暂无可用分组')}
        </div>}

        <div className="tp-foot" data-tray-section="footer">
          <button type="button" className="tp-profile-trigger" aria-label="切换订阅"
            title={`当前订阅：${snap?.profiles.find(p => p.id === snap.activeProfile)?.name ?? '暂无订阅'}`}
            disabled={!fresh || runtimeDisplay.transitioning} aria-expanded={profilesOpen} aria-controls={profilesOpen ? 'tray-profile-list' : undefined}
            onClick={() => { resetLatency(); setProfilesOpen(value => !value); }}><IconProfiles size={16} /><span>切换订阅</span></button>
          <button type="button" aria-label="打开主界面" title="打开主界面" onClick={() => act('open', 'overview')}>
            <IconOverview size={18} />
          </button>
          <div className="spacer" />
          <button type="button" aria-label="设置" title="设置" onClick={() => act('open', 'settings')}>
            <IconSettings size={18} />
          </button>
          <button type="button" className="tp-restart" aria-label="重启应用" title="重启应用" onClick={() => act('restart')}>
            <IconRestart size={18} />
          </button>
          <button type="button" className="tp-quit" aria-label="退出应用" title="退出应用" onClick={() => act('quit')}>
            <IconPower size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
