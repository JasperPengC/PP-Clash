import { AnimatedDetails } from '../components/AnimatedDetails';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog } from '../components/Dialog';
import { NodeName } from '../components/NodeName';
import { EmptyState, ReadError, navigate, Spinner, Toggle } from '../components/ui';
import {
  IconAlert,
  IconImport,
  IconFlag,
  IconNodes,
  IconRefresh,
  IconSearch,
  IconX,
} from '../components/icons';
import { isGroupNode, useApp, type ProxyNode } from '../store/app';
import { buildProxyDomain, proxyGroupKind, resolveProxyRoute, type ProxyRoute } from '../core/proxy-domain';
import { STABLE_EGRESS_GROUP } from '../core/generator';
import { GITHUB_LATENCY_URL, groupLatencyTarget, latencyKey, readGroupLatency } from '../core/latency';
import { createLatencyBatchRunner, type LatencyBatchHandle, type LatencyBatchProgress } from '../core/latency-batch';

function delayBadge(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return 'node-delay';
  if (ms < 100) return 'node-delay ok';
  if (ms < 200) return 'node-delay fair';
  if (ms < 400) return 'node-delay slow';
  return 'node-delay bad';
}

const WINDOW_SIZE = 60;
// 页面卸载只取消批次；在途请求的槽位由模块调度器继续持有。
const batchRunner = createLatencyBatchRunner();

export function visibleGroupTabs<T extends { name: string }>(groups: T[], activeGroup: string | undefined, recentGroups: string[], limit: number): T[] {
  const byName = new Map(groups.map(group => [group.name, group]));
  const names = [...new Set([activeGroup, ...recentGroups, ...groups.map(group => group.name)])];
  return names.flatMap(name => name && byName.has(name) ? [byName.get(name)!] : []).slice(0, Math.max(1, limit));
}

export function orderedGroupNodes<T extends { name: string; delay?: number | null }>(nodes: T[], selectedName: string, sort: 'default' | 'delay' | 'name', availability: 'all' | 'available'): T[] {
  return nodes.filter(node => availability === 'all' || node.delay === undefined || (node.delay !== null && node.delay > 0)).sort((a, b) => {
    if (a.name === selectedName || b.name === selectedName) return Number(b.name === selectedName) - Number(a.name === selectedName);
    if (sort === 'name') return a.name.localeCompare(b.name);
    const da = a.delay != null && a.delay > 0 ? a.delay : Infinity;
    const db = b.delay != null && b.delay > 0 ? b.delay : Infinity;
    return da === db ? 0 : da - db;
  });
}

/** 两列共用行高；已渲染行按实际高度校正，长名称和路径详情不裁切。 */
function VirtualNodeList({ nodes, group, renderNode }: { nodes: ProxyNode[]; group: string; renderNode: (node: ProxyNode, index: number) => ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [measurement, setMeasurement] = useState(0);
  const [columns, setColumns] = useState(2);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const rowCount = Math.ceil(nodes.length / columns);
  const rowKeys = Array.from({ length: rowCount }, (_, row) => JSON.stringify(nodes.slice(row * columns, (row + 1) * columns).map(node => node.name)));
  const offsets = [0];
  for (const key of rowKeys) offsets.push(offsets.at(-1)! + (heights.current.get(key) ?? 78));
  const windowRows = WINDOW_SIZE / columns;
  let first = 0;
  while (first + 1 < rowCount && offsets[first + 1] <= scrollTop) first++;
  const start = Math.max(0, Math.min(first - 3, rowCount - windowRows));
  const end = Math.min(rowCount, start + windowRows);

  useLayoutEffect(() => {
    const element = viewport.current!;
    const resize = () => { if (element.clientWidth) setColumns(element.clientWidth < 660 ? 1 : 2); };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const measure = () => {
      let changed = false;
      for (const row of viewport.current!.querySelectorAll<HTMLElement>('.proxy-virtual-row')) {
        const height = row.getBoundingClientRect().height;
        const key = row.dataset.rowKey!;
        if (height > 0 && heights.current.get(key) !== height) { heights.current.set(key, height); changed = true; }
      }
      if (changed) setMeasurement(value => value + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    viewport.current!.querySelectorAll('.proxy-virtual-row').forEach(row => observer.observe(row));
    return () => observer.disconnect();
  }, [start, end, columns, nodes, measurement]);

  useLayoutEffect(() => {
    if (focusIndex === null) return;
    const control = viewport.current!.querySelector<HTMLButtonElement>(`[data-node-index="${focusIndex}"] .proxy-node-select`);
    (control?.disabled ? viewport.current : control)?.focus();
    setFocusIndex(null);
  }, [start, end, focusIndex]);

  return <div ref={viewport} className="proxy-node-viewport" id={`proxy-group-${encodeURIComponent(group)}`} role="list"
    aria-label={`${group} 节点`} tabIndex={0} style={{ '--proxy-columns': columns } as CSSProperties}
    onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
    onKeyDown={event => {
      if (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains('proxy-node-select')) return;
      const index = Number((event.target as HTMLElement).closest<HTMLElement>('[data-node-index]')?.dataset.nodeIndex ?? start * columns);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1
        : event.key === 'ArrowDown' ? index + columns : event.key === 'ArrowUp' ? index - columns
        : event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : null;
      if (next === null || !nodes.length) return;
      event.preventDefault();
      const target = Math.max(0, Math.min(next, nodes.length - 1));
      const top = offsets[Math.floor(target / columns)];
      viewport.current!.scrollTop = top;
      setScrollTop(top);
      setFocusIndex(target);
    }}>
    <div className="proxy-virtual-spacer" style={{ height: offsets[start] }} aria-hidden="true" />
    <div className="proxy-node-grid">
      {rowKeys.slice(start, end).map((key, offset) => <div className="proxy-virtual-row" data-row-key={key} key={key}>
        {nodes.slice((start + offset) * columns, (start + offset + 1) * columns).map((node, index) => renderNode(node, (start + offset) * columns + index))}
      </div>)}
    </div>
    <div className="proxy-virtual-spacer" style={{ height: offsets[rowCount] - offsets[end] }} aria-hidden="true" />
  </div>;
}

function RouteDetails({ route }: { route: ProxyRoute }) {
  return <div className="proxy-route-details">
    <div className="proxy-route-line"><span>选择关系</span><span>{route.selection.join(' → ') || '尚未确认'}</span></div>
    {route.kind === 'multiple' && <p>多出口 · 由内核按连接分配，不能确认唯一出口</p>}
    {route.forwarding.length > 0 && <div className="proxy-route-line"><span>{route.kind === 'relay' ? '原 Relay 顺序' : '转发顺序'}{route.certainty === 'configuration' ? ' · 配置推断' : ''}</span><span>{route.forwarding.join(' → ')}</span></div>}
    {route.issues.map(issue => <p className="proxy-route-note" key={`${issue.code}:${issue.at}`}>{issue.message}</p>)}
  </div>;
}

export function ProxiesPage({ active = true }: { active?: boolean } = {}) {
  const groups = useApp((s) => s.groups);
  const proxyRuntime = useApp((s) => s.proxyRuntime);
  const kernelPhase = useApp((s) => s.kernelPhase);
  const connectedAt = useApp((s) => s.connectedAt);
  const runtimeConfigRevision = useApp((s) => s.runtimeConfigRevision);
  const runtimeConfigTransition = useApp((s) => s.runtimeConfigTransition);
  const profiles = useApp((s) => s.profiles);
  const activeId = useApp((s) => s.activeId);
  const selectNode = useApp((s) => s.selectNode);
  const fixedNodes = useApp((s) => s.fixedNodes);
  const egressGuard = useApp((s) => s.settings.egressGuard);
  const egressGuardNode = useApp((s) => s.settings.egressGuardNode);
  const toggleFixedNode = useApp((s) => s.toggleFixedNode);
  const testDelay = useApp((s) => s.testDelay);
  const publishDelayBatch = useApp((s) => s.publishDelayBatch);
  const refreshGroups = useApp((s) => s.refreshGroups);
  const notify = useApp((s) => s.notify);

  const [pendingNode, setPendingNode] = useState<string | null>(null);
  const nodeLock = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshLock = useRef(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = async () => {
    if (refreshLock.current) return;
    refreshLock.current = true; setRefreshing(true);
    try {
      const ok = await refreshGroups(false);
      if (ok) void useApp.getState().refreshProxyProviders(true);
      setRefreshError(ok ? null : '无法读取节点，显示上次数据，请重试');
    } catch (e) { setRefreshError(String(e)); }
    finally { refreshLock.current = false; setRefreshing(false); }
  };
  const choose = async (group: string, name: string, fixed = false) => {
    if (nodeLock.current) return;
    nodeLock.current = true; setPendingNode(`${group}|${name}`);
    try { await (fixed ? toggleFixedNode(group, name) : selectNode(group, name)); }
    catch (e) { notify('error', `切换节点失败：${String(e)}`); }
    finally { nodeLock.current = false; setPendingNode(null); }
  };

  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'default' | 'delay' | 'name'>('default');
  const [hideUnavailable, setHideUnavailable] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<{ scope: string; name: string } | null>(null);
  const [recentGroups, setRecentGroups] = useState<{ scope: string; names: string[] } | null>(null);
  const [allGroupsOpen, setAllGroupsOpen] = useState(false);
  const [groupQuery, setGroupQuery] = useState('');
  const [inspectedNode, setInspectedNode] = useState<{ scope: string; name: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [delays, setDelays] = useState<Record<string, number | null>>({});
  const [testingNodes, setTestingNodes] = useState<Set<string>>(new Set());
  const testingLock = useRef(false);
  const testEpoch = useRef(0);
  const batch = useRef<LatencyBatchHandle | null>(null);
  const visible = useRef(active);
  visible.current = active;
  const [progress, setProgress] = useState<LatencyBatchProgress | null>(null);
  const [windowReset, setWindowReset] = useState(0);
  const [focusGroup, setFocusGroup] = useState<string | null>(null);

  const connected = kernelPhase === 'running';
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeId),
    [profiles, activeId]
  );

  const snapshot = proxyRuntime?.profileId === activeId && proxyRuntime?.revision === runtimeConfigRevision
    && proxyRuntime?.connectedAt === connectedAt ? proxyRuntime : null;
  const runtimeMatches = connected && (!proxyRuntime || !!snapshot);
  const domain = useMemo(() => buildProxyDomain({ raw: activeProfile?.raw, groups: runtimeMatches ? groups : [],
    profileId: activeId, revision: runtimeConfigRevision, runtime: runtimeMatches,
    runtimeProxies: snapshot?.proxies, providers: snapshot?.providers, providersError: snapshot?.providersError }),
    [activeProfile?.raw, groups, activeId, runtimeConfigRevision, runtimeMatches, snapshot]);
  const usingPreview = !runtimeMatches || (groups.length === 0 && !snapshot);
  const displayGroups = domain.groups;
  const waitingForSources = displayGroups.some(group=>group.providers.some(provider=>['waiting','error'].includes(provider.state)));

  useEffect(() => {
    testEpoch.current += 1;
    testingLock.current = false;
    setDelays({});
    setTesting(false);
    setTestingNodes(new Set());
    setProgress(null);
    setWindowReset(value => value + 1);
    setAllGroupsOpen(false);
    return () => { testEpoch.current += 1; batch.current?.cancel(true); };
  }, [activeId, connectedAt, connected, runtimeConfigRevision, runtimeConfigTransition]);

  useEffect(() => {
    if (active) return;
    testEpoch.current++;
    batch.current?.cancel(true);
    testingLock.current = false;
    setTesting(false);
    setTestingNodes(new Set());
    setProgress(previous => previous?.status === 'running' ? { ...previous, status: 'cancelled' } : previous);
  }, [active]);

  useEffect(() => {
    if (!focusGroup) return;
    const current = document.getElementById(`proxy-group-${encodeURIComponent(focusGroup)}`)?.querySelector<HTMLElement>('.proxy-node.selected .proxy-node-select');
    current?.focus();
    current?.scrollIntoView?.({ block: 'nearest' });
    setFocusGroup(null);
  }, [focusGroup, windowReset, query, hideUnavailable]);

  const changeQuery = (value: string) => {
    setQuery(value);
    setInspectedNode(null);
  };

  const nodeLatency = (group: string, node: ProxyNode) => readGroupLatency(delays, group, node.name, node.delaysByTarget);
  const visibleNodes = (groupName: string, nodes: typeof displayGroups[number]['nodes'], search = query, onlyAvailable = hideUnavailable) => {
    const q = search.trim().toLowerCase();
    const group = displayGroups.find(item => item.name === groupName);
    const selected = !usingPreview && group?.type !== 'LoadBalance' && group?.type !== 'Relay' ? group?.now ?? '' : '';
    return orderedGroupNodes(nodes.filter(node => !q || node.name.toLowerCase().includes(q)).map(node => ({ ...node, delay: nodeLatency(groupName, node) })),
      selected, sortBy, onlyAvailable ? 'available' : 'all').map(node => ({ ...node, delay: node.delay ?? null }));
  };

  const runTest = (targets: Array<{ group: string; node: string }>) => {
    if (testingLock.current || !connected || !active || runtimeConfigTransition || targets.length === 0) return;
    testingLock.current = true;
    const epoch = ++testEpoch.current;
    const session = useApp.getState();
    const isCurrent = () => {
      const state = useApp.getState();
      return epoch === testEpoch.current && visible.current && state.activeId === session.activeId &&
        state.connectedAt === session.connectedAt && state.kernelPhase === 'running'
        && !state.runtimeConfigTransition && state.runtimeConfigRevision === session.runtimeConfigRevision;
    };
    const items = targets.map(item => ({ ...item, target: groupLatencyTarget(item.group) }));
    setTesting(true);
    setTestingNodes(new Set(items.map(item => latencyKey(item.group, item.target, item.node))));
    batch.current = batchRunner.start(items, {
      requestScope: JSON.stringify([session.activeId, session.connectedAt, session.runtimeConfigRevision]),
      isCurrent,
      measure: item => testDelay(item.node, item.target, { publish: false, isCurrent }),
      onUpdate: update => {
        if (!isCurrent()) return;
        if (update.results.length) {
          publishDelayBatch(update.results);
          setDelays(previous => {
            const next = { ...previous };
            for (const result of update.results) next[latencyKey(result.group, result.target, result.node)] = result.delay;
            return next;
          });
          setTestingNodes(previous => {
            const next = new Set(previous);
            for (const result of update.results) next.delete(latencyKey(result.group, result.target, result.node));
            return next;
          });
        }
        setProgress(update.progress);
        if (update.progress.status !== 'running') {
          testingLock.current = false;
          setTesting(false);
          setTestingNodes(new Set());
          if (update.progress.status === 'completed') notify('info', '测速完成');
        }
      },
    });
  };

  const testGroup = (groupName: string, nodes: typeof displayGroups[number]['nodes']) =>
    runTest(visibleNodes(groupName, nodes).map(node => ({ group: groupName, node: node.name })));

  const locateCurrent = (group: typeof displayGroups[number]) => {
    if (!group.nodes.some(node => node.name === group.now)) return;
    changeQuery('');
    setHideUnavailable(false);
    setSelectedGroup({ scope: domain.identity, name: group.name });
    setWindowReset(value => value + 1);
    setFocusGroup(group.name);
  };

  const currentGroupName = selectedGroup?.scope === domain.identity && displayGroups.some(group => group.name === selectedGroup.name)
    ? selectedGroup.name : displayGroups[0]?.name;
  const filteredGroups = displayGroups.filter(group => group.name === currentGroupName).map(g => ({ g, nodes: visibleNodes(g.name, g.nodes) }));
  const tabs = visibleGroupTabs(displayGroups, currentGroupName, recentGroups?.scope === domain.identity ? recentGroups.names : [], 4);
  const inspectGroup = (name: string) => {
    setRecentGroups(previous => ({ scope: domain.identity, names: [...new Set([name, currentGroupName ?? '', ...(previous?.scope === domain.identity ? previous.names : [])])].filter(Boolean).slice(0, 8) }));
    setSelectedGroup({ scope: domain.identity, name });
    setInspectedNode(null);
    changeQuery('');
    setAllGroupsOpen(false);
  };
  const groupMatches = displayGroups.filter(group => {
    const q = groupQuery.trim().toLowerCase();
    return !q || group.name.toLowerCase().includes(q) || group.nodes.some(node => node.name.toLowerCase().includes(q));
  });

  const subTitle = (() => {
    if (profiles.length === 0) return '导入订阅后显示节点';
    if (runtimeConfigTransition) return '配置切换中 · 显示上次结果';
    if (usingPreview)
      return `${displayGroups.length} 个分组 · 订阅预览`;
    if (!connected) return '未接管';
    if (!displayGroups.length) return '暂无分组';
    return `${displayGroups.length} 个分组`;
  })();

  const emptyView = (() => {
    if (profiles.length === 0) {
      return {
        icon: <IconImport size={19} />,
        title: '尚未导入订阅',
        desc: '支持订阅链接和本地配置文件',
        action: (
          <button type="button" className="btn btn-primary" onClick={() => navigate('profiles')}>
            导入订阅
          </button>
        ),
      };
    }
    if (!connected) {
      return {
        icon: <IconNodes size={19} />,
        title: '内核未运行',
        desc: '未接管流量。',
        action: (
          <button type="button" className="btn btn-primary" onClick={() => navigate('overview')}>
            去概览开启
          </button>
        ),
      };
    }
    return {
      icon: <IconAlert size={19} />,
      title: '没有读到节点',
      desc: '内核没有返回节点分组。',
      action: (
        <button type="button" className="btn" onClick={() => void refresh()}>
          刷新
        </button>
      ),
    };
  })();

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">节点</h1>
          <div className="page-sub">{subTitle}</div>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="icon-btn"
            title="刷新节点"
            aria-label="刷新节点"
            disabled={!connected || refreshing}
            onClick={() => void refresh()}
          >
            <IconRefresh size={15} />
          </button>
        </div>
      </header>

      <div className="page-scroll proxy-page">
        <div className="page-inner">
          <section className={displayGroups.length > 0 ? 'proxy-browser' : 'proxy-browser-empty'} aria-label="节点浏览">
          {displayGroups.length > 0 && <div className="proxy-browser-chrome">
          <div className="proxy-toolbar" aria-label="节点工具条">
          <div className="node-search">
            <IconSearch size={12} />
            <input
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              placeholder="搜索当前分组的节点名称"
              aria-label="搜索节点"
              spellCheck={false}
            />
            {query && (
              <button
                type="button"
                className="node-search-clear"
                aria-label="清空搜索"
                onClick={() => changeQuery('')}
              >
                <IconX size={11} />
              </button>
            )}
          </div>
          <div className="proxy-available">
            <span>仅显示可用</span>
            <Toggle
              on={hideUnavailable}
              onChange={value => { setHideUnavailable(value); setInspectedNode(null); }}
              label="仅显示可用节点"
            />
          </div>
          <div className="seg" role="group" aria-label="排序方式">
            {(
              [
                ['default', '默认'],
                ['delay', '延迟'],
                ['name', '名称'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`seg-btn${sortBy === value ? ' active' : ''}`}
                aria-pressed={sortBy === value}
                onClick={() => { setSortBy(value); setInspectedNode(null); }}
              >
                {label}
              </button>
            ))}
          </div>
            <button type="button" className="btn proxy-test-filtered"
              disabled={!active || !connected || usingPreview || runtimeConfigTransition || testing || !filteredGroups.some(item => item.nodes.length)}
              onClick={() => runTest(filteredGroups.flatMap(({ g, nodes }) => nodes.map(node => ({ group: g.name, node: node.name }))))}>
              测速筛选结果
            </button>
          </div>
          <div className="proxy-filter-summary">
            <span>当前分组 · {waitingForSources && filteredGroups.every(item=>item.nodes.length===0) ? '节点源待加载' : `${filteredGroups.reduce((count, item) => count + item.nodes.length, 0)} 个${query || hideUnavailable ? '匹配' : ''}成员项`}</span>
            {usingPreview && <span>订阅预览 · 连接后可切换和测速</span>}
          </div>
          </div>}
          {progress && <div className="proxy-test-status" role="status" aria-live="polite">
            <span>{progress.status === 'running' ? '测速中' : progress.status === 'cancelled' ? '已取消' : '测速完成'} · {progress.completed} / {progress.total}</span>
            {testing && <button type="button" className="btn btn-sm" aria-label="取消测速" onClick={() => batch.current?.cancel()}>取消</button>}
          </div>}
          {runtimeConfigTransition && <p className="proxy-scope-note" role="status">配置正在切换，当前运行链路尚未确认；切换完成后恢复选择和测速。</p>}
          {refreshError && <ReadError message={refreshError} busy={refreshing} onRetry={() => void refresh()} />}
          {displayGroups.length === 0 ? (
            <section className="card">
              <EmptyState {...emptyView} />
            </section>
          ) : (
            <>
              {filteredGroups.length === 0 && <div className="proxy-empty">
                <span>没有匹配的节点</span>
                <button type="button" className="btn btn-sm" onClick={() => changeQuery('')}>清空搜索</button>
              </div>}
                <div className="proxy-group-pane">
                <nav className="proxy-group-sidebar" aria-label="策略分组">
                  {tabs.map(g => <button type="button" key={g.name}
                    className={`proxy-group-nav${g.name === currentGroupName ? ' active' : ''}`}
                    aria-label={`查看分组 ${g.name}`} aria-current={g.name === currentGroupName ? 'true' : undefined}
                    title={g.name} onClick={() => inspectGroup(g.name)}>
                    <span className="proxy-group-nav-name">{g.name}</span>
                    <span className="proxy-group-nav-meta">{g.name === currentGroupName ? '当前分组' : proxyGroupKind(g.type)}</span>
                  </button>)}
                  <button type="button" className="btn proxy-all-groups" aria-label={`全部分组 ${displayGroups.length}`}
                    aria-haspopup="dialog" aria-expanded={allGroupsOpen} onClick={() => { setGroupQuery(''); setAllGroupsOpen(true); }}>
                    全部分组 <span>{displayGroups.length}</span>
                  </button>
                </nav>
                </div>
              <div className="proxy-workspace">
              <div className="proxy-groups">
                {filteredGroups.filter(item => item.g.name === currentGroupName).map(({ g, nodes }) => {
                  const target = groupLatencyTarget(g.name);
                  const groupTesting = nodes.some((n) => testingNodes.has(latencyKey(g.name, target, n.name)));
                  const current = g.type === 'LoadBalance' || g.type === 'Relay' ? '' : g.now;
                  const route = resolveProxyRoute(domain, g.name);
                  const canSelect = connected && !usingPreview && !runtimeConfigTransition && !g.synthetic && g.type === 'Selector';
                  const chainSelected = !!domain.objects.get(route.terminal ?? '')?.dialerProxy;
                  return (
                    <section key={g.name} className="proxy-group expanded" aria-label={g.name}>
                      <div className="proxy-group-head">
                        <div className="proxy-group-heading">
                          <div className="proxy-group-title-line">
                            <h2 className="proxy-group-name" title={g.name}>{g.name}</h2>
                            <span className="proxy-group-kind">{proxyGroupKind(g.type)}</span>
                            <span className="proxy-group-count">{!nodes.length && g.providers.some(provider=>['waiting','error'].includes(provider.state)) ? '成员待加载' : nodes.length === g.nodes.length ? `${g.nodes.length} 个成员` : `${nodes.length} / ${g.nodes.length}`}</span>
                          </div>
                          <div className="proxy-group-meta">
                            <span>{g.synthetic ? '浏览分组 · 非配置中的策略' : usingPreview ? '订阅预览 · 尚未确认当前选择' : g.type === 'LoadBalance' ? '多出口 · 按连接分配' : g.type === 'Relay' ? '兼容输入 · 内核支持未验证' : g.type === 'Selector' ? '选择此组的使用节点' : '由内核管理选择'}</span>
                          </div>
                        </div>
                        <div className="proxy-group-current-summary" aria-label="当前选择">
                          <span>当前选择</span>
                          <strong>{current ? <NodeName name={current} /> : g.synthetic ? '浏览全部节点' : g.type === 'LoadBalance' ? '多出口' : g.type === 'Relay' ? '原顺序 · 未验证' : g.providers.some(provider => provider.state === 'waiting') ? '等待节点源' : '尚未确认'}</strong>
                        </div>
                        <div className="proxy-group-actions">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={!active || !connected || usingPreview || runtimeConfigTransition || testing || nodes.length === 0}
                            onClick={(e) => {
                              e.stopPropagation();
                              testGroup(g.name, g.nodes);
                            }}
                          >
                            {groupTesting && <Spinner small />}
                            {groupTesting ? '测速中' : '测速'}
                          </button>
                          <button type="button" className="btn btn-sm"
                            aria-label={`${g.name} 定位当前节点`}
                            disabled={usingPreview || !current || !g.nodes.some(node => node.name === current)}
                            onClick={event => { event.stopPropagation(); locateCurrent(g); }}>
                            定位当前
                          </button>
                        </div>
                      </div>

                      {!g.synthetic && <AnimatedDetails className="proxy-route-disclosure"><summary>查看选择关系与转发路径</summary><RouteDetails route={route} /></AnimatedDetails>}
                      {g.providers.length > 0 && <div className="proxy-provider-status" aria-label="节点来源">
                        <span>订阅中的节点源 · 成员来源以运行快照为准</span>
                        {g.providers.map(provider => <div key={provider.name}>
                          <strong>{provider.name}</strong>
                          <span>{({waiting:'等待节点源',loaded:`已加载 ${provider.count} 个节点`,empty:'已加载 · 暂无节点',cached:'源读取失败 · 显示上次结果',error:'源读取失败'} as const)[provider.state]}</span>
                          {provider.updatedAt && <time dateTime={provider.updatedAt} title={provider.updatedAt}>更新于 {Number.isNaN(Date.parse(provider.updatedAt)) ? provider.updatedAt : new Date(provider.updatedAt).toLocaleString()}</time>}
                          {provider.error && <span>{provider.error}</span>}
                        </div>)}
                      </div>}
                      {g.membershipUncertain && <p className="proxy-scope-note">预览未执行内核的动态筛选条件，实际成员以内核为准。</p>}
                      {chainSelected && <p className="proxy-scope-note">固定仅作用于此组中的落地节点；前置策略仍可变化，实际转发链路未确认。</p>}
                      <div className="proxy-member-caption"><span>成员 / 协议 / 来源</span><span title={target}>{target === GITHUB_LATENCY_URL ? 'GitHub 目标延迟' : '节点延迟'}</span></div>
                        {nodes.length === 0 && <div className="proxy-empty">{g.providers.some(provider => provider.state === 'waiting') ? '等待节点源加载后显示成员' : '没有符合筛选条件的节点'}</div>}
                        <VirtualNodeList key={JSON.stringify([domain.identity, g.name, query, sortBy, hideUnavailable, windowReset])}
                          nodes={nodes} group={g.name} renderNode={(node, index) => {
                            const key = latencyKey(g.name, target, node.name);
                            const ms = nodeLatency(g.name, node);
                            const selected = !usingPreview && current === node.name;
                            const fixed = fixedNodes[activeId ?? '']?.[g.name] === node.name;
                            const nestedGroup = isGroupNode(node, displayGroups);
                            const fixedDisabled = pendingNode !== null || runtimeConfigTransition || (!fixed && (!canSelect || nestedGroup));
                            const object = domain.objects.get(node.name);
                            const inspected = inspectedNode?.scope === domain.identity && inspectedNode.name === node.name;
                            const fixedTitle = fixed ? '取消固定（保持当前出口）'
                              : !connected || usingPreview ? '连接后才能固定使用节点'
                              : nestedGroup ? '展开对应分组后固定具体节点'
                              : g.type !== 'Selector' ? '此组由内核自动测速、故障转移或负载均衡，暂不支持固定使用'
                              : object?.dialerProxy ? '仅固定此组的落地节点；前置策略仍可变化，不能保证整条链路固定'
                              : '固定此组的节点选择；实际转发链路未确认，故障时按保守规则切换';
                            const fixedEgress =
                              egressGuard &&
                              g.name === STABLE_EGRESS_GROUP &&
                              egressGuardNode === node.name;
                            const busy = testingNodes.has(key);
                            return (
                              <div
                                key={node.name}
                                role="listitem"
                                aria-posinset={index + 1}
                                aria-setsize={nodes.length}
                                data-node-index={index}
                                className={`proxy-node${selected ? ' selected' : ''}`}
                                onClick={() => { if (canSelect && !nodeLock.current) void choose(g.name, node.name); }}
                              >
                                <button type="button" className={`proxy-node-select${selected ? ' selected' : ''}`}
                                  aria-pressed={selected} disabled={!canSelect || pendingNode !== null} title={node.name}>
                                <span className="proxy-node-indicator" aria-hidden="true">
                                  {pendingNode === `${g.name}|${node.name}` ? <Spinner small /> : <span />}
                                </span>
                                <span className="proxy-node-name">
                                  <NodeName name={node.name} />
                                  <span className="proxy-node-meta">{nestedGroup ? `策略 · ${proxyGroupKind(node.type)}` : node.type || '未知引用'}{object?.providers.length ? ` · ${object.providers.join(' / ')}` : ''}{object?.dialerProxy ? ' · 含前置' : ''}{!canSelect ? ' · 只读' : ''}</span>
                                  {(selected || fixed || fixedEgress) && <span className="node-states">
                                    {selected && <span className="node-state current">当前</span>}
                                    {(fixed || fixedEgress) && <span className="node-state fixed">固定</span>}
                                  </span>}
                                </span>
                                </button>
                                {g.name === STABLE_EGRESS_GROUP ? (
                                  <span
                                    className={`node-pin fixed${fixedEgress ? ' pinned' : ''}`}
                                    title={
                                      fixedEgress
                                        ? '当前 GitHub 固定出口'
                                        : '点击节点切换 GitHub 固定出口'
                                    }
                                  >
                                    <IconFlag size={11} filled={fixedEgress} />
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className={`node-pin${fixed ? ' pinned' : ''}`}
                                    aria-label={fixed ? `取消固定 ${node.name}` : `固定使用 ${node.name}`}
                                    aria-pressed={fixed}
                                    disabled={fixedDisabled}
                                    title={fixedTitle}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void choose(g.name, node.name, true);
                                    }}
                                  >
                                    <IconFlag
                                      size={11}
                                      filled={fixed}
                                    />
                                  </button>
                                )}
                                <button type="button" className="proxy-node-details-btn" aria-label={`查看路径 ${node.name}`}
                                  aria-expanded={inspected} onClick={event => {event.stopPropagation(); setInspectedNode(inspected ? null : {scope:domain.identity,name:node.name});}}>路径</button>
                                {busy ? (
                                  <span className="node-delay">
                                    <Spinner small />
                                  </span>
                                ) : (
                                  <span className={delayBadge(ms)}>
                                    {ms === undefined ? '未测' : ms === null ? '失败' : `${ms} ms`}
                                  </span>
                                )}
                                {inspected && <div className="proxy-node-detail" onClick={event=>event.stopPropagation()}>
                                  <RouteDetails route={resolveProxyRoute(domain,node.name)} />
                                  {nestedGroup && <button type="button" className="btn btn-sm" onClick={() => inspectGroup(node.name)}>查看此策略成员</button>}
                                  <p>固定范围：{nestedGroup ? '先进入对应分组，再固定具体节点。' : '仅固定此组中的节点选择；前置策略仍可变化，实际链路未确认。'}</p>
                                </div>}
                              </div>
                            );
                          }} />
                    </section>
                  );
                })}
              </div>
              </div>

            </>
          )}
          </section>
          <Dialog open={allGroupsOpen} labelledBy="proxy-group-picker-title" onDismiss={() => setAllGroupsOpen(false)}>
            <div className="proxy-group-picker-head">
              <h2 id="proxy-group-picker-title">全部分组 <span>{displayGroups.length}</span></h2>
              <button type="button" className="icon-btn" aria-label="关闭全部分组" onClick={() => setAllGroupsOpen(false)}><IconX size={14} /></button>
            </div>
            <label className="proxy-group-picker-search"><IconSearch size={14} /><input aria-label="搜索全部分组"
              placeholder="搜索分组或成员名称" value={groupQuery} onChange={event => setGroupQuery(event.target.value)} spellCheck={false} /></label>
            <div className="proxy-group-options" aria-label="全部策略分组">
              {groupMatches.map(g => <button type="button" key={g.name} className={`proxy-group-option${g.name === currentGroupName ? ' active' : ''}`}
                aria-current={g.name === currentGroupName ? 'true' : undefined} onClick={() => inspectGroup(g.name)}>
                <span className="proxy-group-option-title"><strong>{g.name}</strong><span>{g.name === currentGroupName ? '当前分组 · ' : ''}{proxyGroupKind(g.type)} · {g.nodes.length} 个成员</span></span>
                <span className="proxy-group-option-current">{g.synthetic ? '浏览全部节点' : g.type === 'LoadBalance' ? '多出口' : g.type === 'Relay' ? '原顺序 · 未验证' : g.now || (g.providers.some(provider => provider.state === 'waiting') ? '等待节点源' : '尚未确认')}</span>
              </button>)}
              {!groupMatches.length && <p className="proxy-group-picker-empty">没有匹配的分组或成员</p>}
            </div>
          </Dialog>
        </div>
      </div>
    </>
  );
}
