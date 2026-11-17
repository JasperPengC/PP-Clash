import { useEffect, useMemo, useRef, useState } from 'react';
import { siGoogle, siYoutube, siGithub, siOpenai, siAnthropic } from 'simple-icons';
import { NodeName } from '../components/NodeName';
import { LatencyRing, MiniSparkline, TrafficChart } from '../components/visuals';
import { PageLink, Select, Spinner, Toggle } from '../components/ui';
import {
  IconBolt,
  IconSecurity,
  IconCheck,
  IconChevronRight,
  IconDownload,
  IconGlobe,
  IconProfiles,
  IconRefresh,
  IconTun,
  IconUpload,
  IconX,
} from '../components/icons';
import { primaryRoutingGroup, resolveActiveNode, resolveEffectiveGroup, useApp } from '../store/app';
import type { ProxyNode } from '../domain/app';
import { api } from '../core/api';
import { useTakeoverStatus } from '../core/use-takeover-status';
import { buildProxyDomain, proxyGroupKind, resolveProxyRoute } from '../core/proxy-domain';
import { useRouteDiagnostics } from '../core/use-diagnostics';
import { startPolling } from '../core/polling';
import { formatBytes, formatDuration, formatExpire, formatSpeed, formatTime } from '../core/format';
import { GITHUB_LATENCY_URL, groupLatencyTarget, latencyKey, normalizeLatency, readGroupLatency } from '../core/latency';

const EMPTY = Array.from({ length: 32 }, () => 0);
const OVERVIEW_NODE_HEIGHT = 34;
const OVERVIEW_NODE_WINDOW = 16;

export function OverviewPage({ active = true }: { active?: boolean }) {
  const kernelPhase = useApp((s) => s.kernelPhase);
  const connectedAt = useApp((s) => s.connectedAt);
  const kernelError = useApp((s) => s.kernelError);
  const groups = useApp((s) => s.groups);
  const proxyRuntime = useApp(s => s.proxyRuntime);
  const profiles = useApp((s) => s.profiles);
  const activeId = useApp((s) => s.activeId);
  const sysProxyEnabled = useApp((s) => s.sysProxyEnabled);
  const tunEnabled = useApp((s) => s.tunEnabled);
  const settings = useApp((s) => s.settings);
  const runtimeConfigRevision = useApp(s => s.runtimeConfigRevision);
  const runtimeConfigTransition = useApp(s => s.runtimeConfigTransition);
  const fixedNodes = useApp(s => s.fixedNodes);
  const [nodeWindowStart, setNodeWindowStart] = useState(0);
  const nodeListRef = useRef<HTMLDivElement>(null);
  const [connCount, setConnCount] = useState<number | null>(null);
  const mixedPort = useApp((s) => s.settings.mixedPort);
  const toggleSystemProxy = useApp((s) => s.toggleSystemProxy);
  const setTun = useApp((s) => s.setTun);
  const selectNode = useApp((s) => s.selectNode);
  const testDelay = useApp((s) => s.testDelay);
  const notify = useApp((s) => s.notify);
  const blockWebRtc = useApp((s) => s.policy.blockWebRtc);
  const [retrying, setRetrying] = useState(false);
  const retryLock = useRef(false);
  const retryConnection = async () => {
    if (retryLock.current) return;
    retryLock.current = true; setRetrying(true);
    try { await useApp.getState().startKernel(); }
    catch (e) { notify('error', `重新连接失败：${String(e)}`); }
    finally { retryLock.current = false; setRetrying(false); }
  };
  const [groupDelays, setGroupDelays] = useState<Record<string, number | null>>({});
  const [connectionDelays, setConnectionDelays] = useState<Record<string, number | null>>({});
  const [testingGroup, setTestingGroup] = useState(false);
  const testGroupLock = useRef(false);
  const testGroupEpoch = useRef(0);
  const latencyPool = useRef({ active: 0, waiting: [] as Array<() => void> });
  const [testingCurrentNode, setTestingCurrentNode] = useState(false);
  const currentLatencyRequest = useRef<symbol | null>(null);
  const currentLatencyRequestKey = useRef<string | null>(null);
  const currentLatencyEpoch = useRef(0);
  const currentLatencyAttempts = useRef(new Set<string>());
  const [pendingNode, setPendingNode] = useState<string | null>(null);
  const nodeLock = useRef(false);
  const connected = kernelPhase === 'running';
  const takeover = useTakeoverStatus({ active, running: connected, sysProxy: sysProxyEnabled, tun: tunEnabled,
    revision: JSON.stringify([runtimeConfigRevision, connectedAt, settings.controllerPort, settings.controllerSecret]),
    transitioning: runtimeConfigTransition,
  });

  useEffect(() => {
    if (active) return;
    testGroupEpoch.current += 1;
    currentLatencyEpoch.current += 1;
    testGroupLock.current = false;
    setTestingGroup(false);
  }, [active]);
  const failed = kernelPhase === 'failed';
  const kernelBusy = kernelPhase === 'starting' || kernelPhase === 'stopping';
  const [proxyPending, setProxyPending] = useState(false);
  const [tunPending, setTunPending] = useState(false);
  const switchesBusy = kernelBusy || proxyPending || tunPending;

  const changeSystemProxy = async (on: boolean) => {
    setProxyPending(true);
    try {
      await toggleSystemProxy(on);
    } finally {
      setProxyPending(false);
    }
  };

  const changeTun = async (on: boolean) => {
    setTunPending(true);
    try {
      await setTun(on);
    } finally {
      setTunPending(false);
    }
  };
  const activeProfile = profiles.find((p) => p.id === activeId);
  const routing = useApp(s => s.routing);
  const routeRevision = useApp(s => s.routeRevision);
  const primaryGroup = primaryRoutingGroup({ groups, profiles, activeId, settings, routing });
  const routingGroups = primaryGroup?.name === 'GLOBAL' ? [primaryGroup, ...groups] : groups;
  const effectiveGroup =
    connected && primaryGroup ? resolveEffectiveGroup(routingGroups, primaryGroup.name) : undefined;
  const nodeName = settings.mode === 'direct' ? 'DIRECT' : resolveActiveNode(routingGroups, primaryGroup?.now ?? '');

  const [up, setUp] = useState<number[]>(EMPTY);
  const [down, setDown] = useState<number[]>(EMPTY);
  const [upTotal, setUpTotal] = useState(0);
  const [downTotal, setDownTotal] = useState(0);
  const [proxyUpBytes, setProxyUpBytes] = useState(0);
  const [proxyDownBytes, setProxyDownBytes] = useState(0);
  const [directUpBytes, setDirectUpBytes] = useState(0);
  const [directDownBytes, setDirectDownBytes] = useState(0);
  const prevConns = useRef<Map<string, { up: number; down: number }>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  const prev = useRef<{ up: number; down: number; ts: number } | null>(null);

  const snapshot = proxyRuntime?.profileId === activeId && proxyRuntime?.revision === runtimeConfigRevision
    && proxyRuntime?.connectedAt === connectedAt ? proxyRuntime : null;
  const runtimeMatches = connected && !runtimeConfigTransition && (!proxyRuntime || !!snapshot);
  const domain = useMemo(() => buildProxyDomain({ raw: activeProfile?.raw, groups: runtimeMatches ? routingGroups : [],
    profileId: activeId, revision: runtimeConfigRevision, runtime: runtimeMatches,
    runtimeProxies: snapshot?.proxies, providers: snapshot?.providers, providersError: snapshot?.providersError }),
    [activeProfile?.raw, groups, primaryGroup, activeId, runtimeConfigRevision, runtimeMatches, snapshot]);
  const displayGroup = domain.groups.find(g => g.name === effectiveGroup?.name) ?? domain.groups[0];
  useEffect(() => {
    testGroupEpoch.current += 1;
    testGroupLock.current = false;
    setGroupDelays({});
    setTestingGroup(false);
    return () => { testGroupEpoch.current += 1; };
  }, [activeId, connectedAt, connected, displayGroup?.name]);
  useEffect(() => { setNodeWindowStart(0); if (nodeListRef.current) nodeListRef.current.scrollTop = 0; }, [displayGroup?.name, activeId]);

  useEffect(() => {
    if (!active) return;
    if (!connected) {
      setUp(EMPTY);
      setDown(EMPTY);
      setUpTotal(0);
      setDownTotal(0);
      setProxyUpBytes(0);
      setProxyDownBytes(0);
      setDirectUpBytes(0);
      setDirectDownBytes(0);
      prev.current = null;
      prevConns.current = new Map();
      return;
    }

    let alive = true;
    prev.current = null;
    prevConns.current = new Map();

    const tick = async () => {
      try {
        const [c, trayRates] = await Promise.all([
          api.mihomo('GET', '/connections') as Promise<any>,
          api.trafficRates().catch(() => null),
        ]);
        if (!alive) return;
        // mihomo 的 /connections 用 uploadTotal / downloadTotal，兼容旧字段名
        const u = c?.uploadTotal ?? c?.uploadTraffic ?? 0;
        const d = c?.downloadTotal ?? c?.downloadTraffic ?? 0;
        const ts = Date.now();
        if (prev.current) {
          const dt = (ts - prev.current.ts) / 1000;
          if (dt > 0) {
            const ownUp = Math.max(0, (u - prev.current.up) / dt);
            const ownDown = Math.max(0, (d - prev.current.down) / dt);
            // 概览与菜单栏/小面板共用 Rust 缓存的速率，避免各自计时导致数字不一致。
            const ur = trayRates && Number.isFinite(trayRates[0]) ? trayRates[0] : ownUp;
            const dr = trayRates && Number.isFinite(trayRates[1]) ? trayRates[1] : ownDown;
            if (alive) {
              setUp((p) => [...p.slice(1), ur]);
              setDown((p) => [...p.slice(1), dr]);
            }
          }
        }
        // 按连接链拆出「直连 / 代理」流量：逐连接做增量，避免连接关闭后字节数丢失
        const list: any[] = Array.isArray(c?.connections) ? c.connections : [];
        if (alive) setConnCount(list.length);
        const next = new Map<string, { up: number; down: number }>();
        let pu = 0;
        let pd = 0;
        let du = 0;
        let dd = 0;
        for (const conn of list) {
          const key = String(conn?.id ?? conn?.start ?? Math.random());
          const cu = Number(conn?.upload ?? 0);
          const cd = Number(conn?.download ?? 0);
          next.set(key, { up: cu, down: cd });
          const before = prevConns.current.get(key);
          if (!before) continue;
          const duDelta = Math.max(0, cu - before.up);
          const ddDelta = Math.max(0, cd - before.down);
          if (duDelta + ddDelta <= 0) continue;
          const chains: string[] = Array.isArray(conn?.chains) ? conn.chains : [];
          const isDirect = chains.length === 0 || chains[chains.length - 1] === 'DIRECT';
          if (isDirect) {
            du += duDelta;
            dd += ddDelta;
          } else {
            pu += duDelta;
            pd += ddDelta;
          }
        }
        prevConns.current = next;
        if (alive) {
          setProxyUpBytes((v) => v + pu);
          setProxyDownBytes((v) => v + pd);
          setDirectUpBytes((v) => v + du);
          setDirectDownBytes((v) => v + dd);
        }

        prev.current = { up: u, down: d, ts };
        if (alive) {
          setUpTotal(u);
          setDownTotal(d);
        }
      } catch {
        /* 内核暂时不可达，下一轮再试 */
      }
    };

    const i1 = startPolling(tick, 1000);
    const i2 = startPolling(async () => { await useApp.getState().refreshGroups(); }, 3000);

    return () => {
      alive = false;
      i1();
      i2();

    };
  }, [connected, active]);

  // 运行时长计时
  useEffect(() => {
    if (!active || !connected || !connectedAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [connected, connectedAt, active]);



  const latestUp = up[up.length - 1] ?? 0;
  const latestDown = down[down.length - 1] ?? 0;

  const githubProbeNode = connected ? nodeName : '';

  const acquireLatencySlot = () => new Promise<void>(resolve => {
    if (latencyPool.current.active < 3) {
      latencyPool.current.active += 1;
      resolve();
    } else latencyPool.current.waiting.push(resolve);
  });
  const releaseLatencySlot = () => {
    const next = latencyPool.current.waiting.shift();
    if (next) next();
    else latencyPool.current.active -= 1;
  };

  const testCurrentGroup = async () => {
    if (!runtimeMatches || !displayGroup || testGroupLock.current || currentLatencyRequest.current) return;
    if (!connected) {
      notify('info', '先开启接管');
      return;
    }
    testGroupLock.current = true;
    const epoch = testGroupEpoch.current;
    const group = displayGroup;
    const target = groupLatencyTarget(group.name);
    const current = () => epoch === testGroupEpoch.current;
    const queue = [...group.nodes];
    const results: Record<string, number | null> = {};
    const worker = async () => {
      while (current() && queue.length) {
        // 旧批次仍占用请求槽，重连后的新批次需等其退出；过期队列不发请求。
        await acquireLatencySlot();
        try {
          if (!current()) return;
          const node = queue.shift();
          if (!node) return;
          let delay: number | null = null;
          try { delay = normalizeLatency(await testDelay(node.name, target)); } catch { /* 失败只更新此节点的测速结果。 */ }
          if (current()) results[latencyKey(group.name, target, node.name)] = delay;
        } finally {
          releaseLatencySlot();
        }
      }
    };
    setTestingGroup(true);
    try {
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
      if (!current()) return;
      setGroupDelays(prev => ({ ...prev, ...results }));
      setConnectionDelays(prev => ({ ...prev, ...results }));
      await useApp.getState().refreshGroups(true).catch(() => false);
    } finally {
      if (current()) {
        testGroupLock.current = false;
        setTestingGroup(false);
      }
    }
  };

  const routeKey = JSON.stringify([routeRevision, connected, connectedAt, activeId, nodeName, settings.mode, tunEnabled, sysProxyEnabled, mixedPort, settings.dnsPort, githubProbeNode, blockWebRtc]);
  const diagnostics = useRouteDiagnostics({
    active, connected, routeKey, mixedPort, dnsPort: settings.dnsPort, tun: tunEnabled, githubNode: githubProbeNode, blockWebRtc,
  });
  const stateText = connected
    ? '运行中'
    : kernelPhase === 'starting'
      ? '正在启动…'
      : kernelPhase === 'stopping'
        ? '正在停止…'
        : failed
          ? '启动失败'
          : '未接管';

  const desc = connected
    ? [primaryGroup?.now && primaryGroup.now !== nodeName ? primaryGroup.now : '已接管系统流量']
        .filter(Boolean)
        .join(' · ')
    : failed
      ? (kernelError ?? '内核未就绪')
      : activeProfile
        ? '开启系统代理或 TUN'
        : '尚未配置出口';

  const uptime = connected && connectedAt ? formatDuration(now - connectedAt) : null;

  const groupHasSingleSelection = displayGroup && ['Selector', 'URLTest', 'Fallback'].includes(displayGroup.type);
  const canSelectMember = runtimeMatches && !displayGroup?.synthetic && displayGroup?.type === 'Selector';
  const groupNow = runtimeMatches && groupHasSingleSelection ? (displayGroup?.now ?? '') : '';
  const nodeLatency = (node: ProxyNode) => {
    const value = readGroupLatency(groupDelays, displayGroup?.name ?? '', node.name, node.delaysByTarget);
    return value === undefined ? undefined : normalizeLatency(value);
  };
  const groupNodes = useMemo(() => displayGroup
    ? [...displayGroup.nodes].sort((a, b) => {
        // 已选中的节点永远排第一，其余按延迟升序
        const aSel = connected && a.name === groupNow;
        const bSel = connected && b.name === groupNow;
        if (aSel !== bSel) return aSel ? -1 : 1;
        const da = nodeLatency(a) ?? Number.MAX_SAFE_INTEGER;
        const db = nodeLatency(b) ?? Number.MAX_SAFE_INTEGER;
        if (da !== db) return da - db;
        return a.name.localeCompare(b.name);
      })
    : [], [displayGroup, connected, groupNow, groupDelays]);

  const displayedLatencyTarget = groupLatencyTarget(displayGroup?.name ?? '');
  const connectionGroup = runtimeMatches ? domain.groups.find(group => group.name === effectiveGroup?.name)
    ?? domain.groups.find(group => group.name === primaryGroup?.name) : undefined;
  const connectionRoute = connectionGroup && settings.mode !== 'direct' ? resolveProxyRoute(domain, primaryGroup?.name ?? connectionGroup.name) : null;
  const directMode = settings.mode === 'direct';
  const directConnection = directMode || connectionRoute?.kind === 'direct';
  const terminalName = directConnection ? 'DIRECT' : connectionRoute?.kind === 'reject' ? connectionRoute.terminal ?? 'REJECT' : null;
  const terminalReading = terminalName === 'DIRECT' ? '直连' : terminalName === 'REJECT-DROP' ? '丢弃' : terminalName === 'REJECT' ? '拒绝' : null;
  const terminalHelper = terminalName === 'DIRECT' ? '直连出口' : terminalName === 'REJECT-DROP' ? '丢弃连接' : '拒绝连接';
  const connectionNode = !directConnection && connectionRoute?.kind === 'selected'
    ? connectionGroup?.nodes.find(node => node.name === nodeName) : undefined;
  const connectionTarget = terminalName || !connectionGroup ? null : groupLatencyTarget(connectionGroup.name);
  const reportedConnectionLatency = connectionNode
    ? readGroupLatency(connectionDelays, connectionGroup!.name, connectionNode.name, connectionNode.delaysByTarget) : undefined;
  const connectionDelay = reportedConnectionLatency === undefined ? undefined : normalizeLatency(reportedConnectionLatency);
  const connectionKey = JSON.stringify([activeId, connectedAt, runtimeConfigRevision, settings.mode, connectionGroup?.name, connectionNode?.name, connectionTarget]);
  const canTestConnection = runtimeMatches && !directConnection && !!connectionNode && !routingGroups.some(group => group.name === connectionNode.name)
    && !['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'].includes(connectionNode.name);
  const actualConnection = {
    group: connectionGroup,
    node: connectionNode,
    name: !runtimeMatches ? '待确认' : terminalName ?? (
      connectionRoute?.kind === 'multiple' ? '按连接分配 · 无唯一出口'
      : connectionRoute?.kind === 'relay' ? 'Relay 能力未核验'
      : connectionRoute?.kind !== 'selected' ? '当前出口待确认' : nodeName || '待确认'),
    auxiliaryLabel: directMode ? '直连模式' : terminalName ? `${primaryGroup?.name ?? '当前策略'} · ${terminalHelper}` : primaryGroup?.name ?? '策略待确认',
    delay: connectionDelay,
    reading: terminalReading ?? (connectionDelay === undefined ? '未测' : connectionDelay === null ? '失败' : `${connectionDelay} ms`),
    target: connectionTarget,
    targetDescription: directMode ? '直连模式，不测速代理候选'
      : terminalName ? `${terminalName} · ${terminalReading}，不测速代理候选`
      : !canTestConnection ? '当前连接不支持单节点测速'
      : `${connectionTarget === GITHUB_LATENCY_URL ? 'GitHub' : 'Google'} HTTPS 延迟 · 点击重测`,
    tone: connectionRoute?.kind === 'reject' ? 'bad' : connectionDelay == null ? 'idle' : connectionDelay < 120 ? 'good' : connectionDelay < 260 ? 'warn' : 'bad',
    canTest: canTestConnection,
    key: connectionKey,
    testing: testingCurrentNode && currentLatencyRequestKey.current === connectionKey,
  };
  useEffect(() => {
    currentLatencyEpoch.current += 1;
    currentLatencyAttempts.current.clear();
    setConnectionDelays({});
    return () => { currentLatencyEpoch.current += 1; };
  }, [activeId, connectedAt, connected, runtimeConfigRevision, settings.mode, connectionGroup?.name, connectionNode?.name]);
  const testCurrentNode = async () => {
    if (!actualConnection.canTest || !actualConnection.node || !actualConnection.group || !actualConnection.target || currentLatencyRequest.current || testGroupLock.current) return;
    const request = Symbol();
    currentLatencyRequest.current = request;
    currentLatencyRequestKey.current = actualConnection.key;
    currentLatencyAttempts.current.add(actualConnection.key);
    const epoch = currentLatencyEpoch.current;
    const group = actualConnection.group.name;
    const resultKey = latencyKey(group, actualConnection.target, actualConnection.node.name);
    setTestingCurrentNode(true);
    await acquireLatencySlot();
    try {
      if (epoch !== currentLatencyEpoch.current) return;
      const delay = normalizeLatency(await testDelay(actualConnection.node.name, actualConnection.target));
      if (epoch === currentLatencyEpoch.current) {
        setConnectionDelays(prev => ({ ...prev, [resultKey]: delay }));
        setGroupDelays(prev => ({ ...prev, [resultKey]: delay }));
      }
    } catch {
      if (epoch === currentLatencyEpoch.current) {
        setConnectionDelays(prev => ({ ...prev, [resultKey]: null }));
        setGroupDelays(prev => ({ ...prev, [resultKey]: null }));
      }
    } finally {
      releaseLatencySlot();
      // 结果代次可以过期，但在途请求仍须释放它自己持有的锁。
      if (currentLatencyRequest.current === request) {
        currentLatencyRequest.current = null;
        currentLatencyRequestKey.current = null;
        setTestingCurrentNode(false);
      }
    }
  };
  useEffect(() => {
    if (!active || !actualConnection.canTest || actualConnection.delay !== undefined || testingGroup || testingCurrentNode
      || currentLatencyAttempts.current.has(actualConnection.key)) return;
    // 当前出口稳定且缺少记录时补一次；窗口隐藏时不开始，不测备用节点。
    const timer = window.setTimeout(() => { void testCurrentNode(); }, 5000);
    return () => window.clearTimeout(timer);
  }, [active, actualConnection.canTest, actualConnection.key, actualConnection.delay, testingGroup, testingCurrentNode]);

  const onSelectNode = async (name: string) => {
    if (!canSelectMember || !displayGroup) return;
    if (nodeLock.current) return;
    nodeLock.current = true;
    setPendingNode(name);
    try { await selectNode(displayGroup.name, name); }
    catch (error) { notify('error', `切换节点失败：${String(error)}`); }
    finally { nodeLock.current = false; setPendingNode(null); }
  };

  const displayNow = groupHasSingleSelection && runtimeMatches ? displayGroup?.now ?? '' : '';
  const visibleStart = Math.min(nodeWindowStart, Math.max(0, groupNodes.length - OVERVIEW_NODE_WINDOW));
  const visibleGroupNodes = groupNodes.slice(visibleStart, visibleStart + OVERVIEW_NODE_WINDOW);

  const routeBreakdown = `代理 ↑${formatBytes(proxyUpBytes)} ↓${formatBytes(proxyDownBytes)} · 直连 ↑${formatBytes(directUpBytes)} ↓${formatBytes(directDownBytes)}`;
  const chartMax = Math.max(1, ...up, ...down);

  return (
    <>
      <header className="page-head ov-page-head">
        <div className="page-heading"><h1 className="page-title">概览</h1></div>
        <div className="ov-takeover-row">
          <section className="switches-card" aria-label="流量接管">
            {([
              { id: 'sysproxy', title: '系统代理', subtitle: proxyPending ? '处理中…' : sysProxyEnabled ? String(mixedPort) : '未开启', detail: takeover.systemProxySubtitle,
                enabled: sysProxyEnabled, busy: proxyPending, icon: <IconGlobe size={15} />, change: changeSystemProxy },
              { id: 'tun', title: 'TUN 模式', subtitle: tunPending ? '处理中…' : tunEnabled ? '已开启' : '未开启', detail: takeover.tunSubtitle,
                enabled: tunEnabled, busy: tunPending, icon: <IconTun size={15} />, change: changeTun },
            ] as const).map(item => <div className="ov-takeover-option" key={item.id} title={item.detail}>
              {item.icon}<span>{item.title}</span><span className="ov-meta">{item.subtitle}</span>
              <Toggle on={item.enabled} busy={item.busy} disabled={switchesBusy} onChange={value => void item.change(value)} label={item.title} />
            </div>)}
          </section>
        </div>
      </header>
      <div className="page-scroll ov-scroll">
        <div className="dash">
          {connected && kernelError && <div className="banner warn ov-warning" role="alert"><span>{kernelError}</span></div>}
          <div className="ov-top-row">
            <section className="ov-panel ov-route-card" aria-label="当前连接">
              <div className="ov-route-meta" title={uptime ? `${stateText} · ${uptime}` : stateText}>
                <span className={`status-dot${connected ? ' on' : failed ? ' warn' : ''}`} aria-hidden="true" />
                <span>当前连接</span><span className="ov-connection-state">{stateText}{uptime && <span> · {uptime}</span>}</span>
              </div>
              <div className="ov-connection-body">
                <div className="ov-identity">
                  <h2 className="ov-hero-node" title={connected ? actualConnection.name : desc}>{connected ? <NodeName name={actualConnection.name} /> : desc}</h2>
                    <p>{connected ? [actualConnection.node?.type, actualConnection.group ? proxyGroupKind(actualConnection.group.type) : actualConnection.targetDescription,
                      actualConnection.node && activeId && fixedNodes[activeId]?.[actualConnection.group?.name ?? ''] === actualConnection.node.name ? '已固定' : ''].filter(Boolean).join(' · ') : activeProfile ? '连接后显示当前策略' : '添加订阅以配置代理节点'}</p>
                </div>
                <span className="ov-route-tag ov-hero-route" title={actualConnection.auxiliaryLabel}>{actualConnection.auxiliaryLabel}</span>
                <button type="button" className={`ov-latency hero-gauge ${actualConnection.tone}`} disabled={!actualConnection.canTest || testingCurrentNode || testingGroup}
                  aria-label={actualConnection.delay != null ? `测速当前节点，延迟 ${actualConnection.delay} 毫秒` : actualConnection.canTest ? '测速当前节点' : actualConnection.targetDescription}
                  title={actualConnection.targetDescription} onClick={() => void testCurrentNode()}>
                  <LatencyRing ms={actualConnection.canTest ? actualConnection.delay ?? null : null} reading={actualConnection.reading} busy={actualConnection.testing} />
                </button>
              </div>
              {failed && <div className="ov-hero-actions"><button type="button" className="btn btn-primary btn-sm" disabled={retrying || kernelBusy} onClick={() => void retryConnection()}>{retrying ? '重试中…' : '重试连接'}</button><PageLink page="logs" label="查看日志" /></div>}
            </section>
            {(['up', 'down'] as const).map(direction => {
              const upload = direction === 'up';
              const [value, unit] = formatSpeed(connected ? (upload ? latestUp : latestDown) : 0).split(' ');
              return <section className={`ov-panel ov-speed-card is-${direction}`} aria-label={upload ? '上传速率' : '下载速率'} key={direction}>
                <div className="ov-speed-head"><div className="ov-speed-label">{upload ? <IconUpload size={15} /> : <IconDownload size={15} />}{upload ? '上传' : '下载'}</div><span className="ov-speed-peak" title="最近 32 秒峰值速度">峰值 <b>{formatSpeed(connected ? Math.max(...(upload ? up : down)) : 0)}</b></span></div>
                <div className="ov-speed-value">{value}<small>{unit}</small></div>
                <div className="ov-speed-note">会话累计 {formatBytes(connected ? (upload ? upTotal : downTotal) : 0)}</div>
                <MiniSparkline points={upload ? up : down} color={upload ? 'var(--up-chart)' : 'var(--down-chart)'} height={33} />
              </section>;
            })}
          </div>
          <div className="ov-main-row">
            <section className="ov-panel ov-chart-card" aria-label="实时流量">
              <div className="ov-panel-head"><h2>实时流量</h2><div className="ov-chart-legend"><span className="is-up">上传</span><span className="is-down">下载</span></div></div>
              <div className="ov-traffic-chart"><TrafficChart up={up} down={down} upColor="var(--up-chart)" downColor="var(--down-chart)" />
                <div className="ov-chart-axis"><span>{formatSpeed(chartMax)}</span><span>{formatSpeed(chartMax / 2)}</span><span>0</span></div></div>
              <div className="ov-chart-times"><span>32 秒前</span><span>现在</span></div>
              <div className="ov-chart-footer"><span title={routeBreakdown}>{connected && connCount != null ? <><b>{connCount}</b> 个活动连接</> : '等待连接'}</span><PageLink page="connections" label="查看连接" /></div>
            </section>
            <section id="overview-members" className="ov-panel group-card ov-strategy-details ov-current-group" aria-label="当前分组">
              <div className="group-head">
                <h2 className="section-title">当前分组</h2>
                <span className="ov-group-tag" title={displayGroup ? `${displayGroup.name} · ${resolveProxyRoute(domain, displayGroup.name).kind === 'multiple' ? '按连接分配' : resolveProxyRoute(domain, displayGroup.name).kind === 'relay' ? '链式转发能力未核验' : proxyGroupKind(displayGroup.type)}` : '暂无分组'}>{displayGroup?.name ?? '暂无分组'}</span>
                <button type="button" className="link-action" title={displayedLatencyTarget === GITHUB_LATENCY_URL ? "测速当前分组 · GitHub 延迟" : "测速当前分组"} aria-label="测速当前分组" disabled={!runtimeMatches || testingGroup || testingCurrentNode} onClick={() => void testCurrentGroup()}>{testingGroup ? <Spinner small /> : <IconBolt size={13} />}{testingGroup ? '测速中' : '测速'}</button>
              </div>
              <div id="overview-nodes" className="ov-nodes-body">
                <div ref={nodeListRef} className="ov-node-list" aria-label="当前分组候选" tabIndex={0}
                  onScroll={event => setNodeWindowStart(Math.max(0, Math.floor(event.currentTarget.scrollTop / OVERVIEW_NODE_HEIGHT) - 2))}>
                  {visibleStart > 0 && <div aria-hidden="true" style={{ height: visibleStart * OVERVIEW_NODE_HEIGHT }} />}
                  {visibleGroupNodes.map(node => {
                    const selected = connected && displayNow === node.name;
                    const ms = nodeLatency(node);
                    return <button key={node.name} type="button" className={`ov-node group-node${selected ? ' selected' : ''}`} title={node.name} aria-pressed={selected} disabled={!canSelectMember || pendingNode !== null} onClick={() => void onSelectNode(node.name)}>
                      <span className="ov-node-name"><NodeName name={node.name} />{selected && activeId && fixedNodes[activeId]?.[displayGroup!.name] === node.name && <span className="ov-node-fixed">固定</span>}</span>
                      <span className="ov-node-status">{pendingNode === node.name ? <Spinner small /> : selected && <span className="ov-node-current" title="当前节点" aria-label="当前节点"><IconCheck size={11} /></span>}<span className={`ov-node-delay${ms === null ? ' is-failed' : ''}`}>{ms === undefined ? '未测' : ms === null ? '失败' : `${ms} ms`}</span></span>
                    </button>;
                  })}
                  {groupNodes.length > visibleStart + visibleGroupNodes.length && <div aria-hidden="true" style={{ height: (groupNodes.length - visibleStart - visibleGroupNodes.length) * OVERVIEW_NODE_HEIGHT }} />}
                  {!groupNodes.length && <div className="ov-group-empty">{!activeProfile ? '导入订阅后显示节点' : displayGroup?.providers.some(provider => provider.state === 'error') ? '节点源读取失败，可在节点页重试' : displayGroup?.providers.some(provider => provider.state === 'waiting') ? '等待节点源加载' : '此分组暂无可见候选'}</div>}
                </div>
              </div>
              {displayedLatencyTarget === GITHUB_LATENCY_URL && <div className="ov-group-target">GitHub 延迟</div>}
            </section>
          </div>
          <div className="ov-bottom-row">
            <OverviewSubscriptionCard />
            <OverviewDiagnostics connected={connected} diagnostics={diagnostics} githubNode={githubProbeNode} sysProxy={sysProxyEnabled} tun={tunEnabled} />
          </div>
        </div>
      </div>
    </>
  );
}

function OverviewSubscriptionCard() {
  const profiles = useApp(s => s.profiles);
  const activeId = useApp(s => s.activeId);
  const activeProfile = profiles.find(profile => profile.id === activeId);
  const refreshingIds = useApp(s => s.refreshingIds);
  const activate = useApp(s => s.activate);
  const refreshProfile = useApp(s => s.refreshProfile);
  const quota = activeProfile?.userinfo ?? null;
  const quotaUsed = quota ? quota.upload + quota.download : 0;
  const quotaRatio = quota && quota.total > 0 ? Math.min(quotaUsed / quota.total, 1) : 0;
  const quotaTone = quotaRatio >= 0.9 ? 'bad' : quotaRatio >= 0.7 ? 'warn' : 'ok';

  return <section className="ov-panel quota-card" aria-label="当前订阅">
    <div className="ov-panel-head"><h2>当前订阅</h2>
      {activeId && <button type="button" className="icon-btn icon-btn-sm" title="更新当前订阅" aria-label="更新当前订阅" disabled={refreshingIds.includes(activeId)} onClick={() => void refreshProfile(activeId)}>{refreshingIds.includes(activeId) ? <Spinner small /> : <IconRefresh size={13} />}</button>}
      <PageLink page="profiles" label={activeProfile ? '管理订阅' : '导入订阅'} />
    </div>
    <div className="ov-subscription-summary">
      <div className="ov-subscription-identity"><span className="ov-subscription-icon"><IconProfiles size={18} /></span><div className="ov-subscription-copy">
        {profiles.length > 1 && activeId
          ? <Select value={activeId} options={profiles.map(profile => ({ value: profile.id, label: profile.name }))} ariaLabel="切换订阅" className="quota-profile-select" onChange={id => void activate(id)} />
          : <strong className="quota-card-name" title={activeProfile?.name}>{activeProfile?.name ?? '尚未添加订阅'}</strong>}
        <p>{activeProfile ? `${formatTime(activeProfile.updatedAt)} 更新${activeProfile.updateIntervalHours ? ` · 每 ${activeProfile.updateIntervalHours} 小时自动更新` : ''}` : '添加订阅后显示用量'}</p>
      </div>{quota && quota.total > 0 && <div className="ov-quota-remaining">{formatBytes(Math.max(quota.total - quotaUsed, 0))}<small>剩余流量</small></div>}</div>
      {quota && quota.total > 0 ? <>
        <div className="ov-quota-progress" role="progressbar" aria-label="订阅配额已用" aria-valuenow={Math.round(quotaRatio * 100)} aria-valuemin={0} aria-valuemax={100}><span className={`ov-quota-fill is-${quotaTone}`} style={{ width: `${quotaRatio * 100}%` }} /></div>
        <div className="quota-card-foot"><span>已用 {formatBytes(quotaUsed)} / {formatBytes(quota.total)}</span><span>{quota.expire > 0 ? `${formatExpire(quota.expire)} 到期` : '不限期'}</span></div>
      </> : <div className="quota-card-foot"><span className="quota-empty">{activeProfile ? '暂无配额信息' : '流量用量会在添加订阅后显示'}</span></div>}
    </div>
  </section>;
}

function OverviewDiagnostics({ connected, diagnostics: d, githubNode, sysProxy, tun }: {
  connected: boolean; diagnostics: ReturnType<typeof useRouteDiagnostics>; githubNode: string; sysProxy: boolean; tun: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const busy = d.servicesLoading || d.leakPhase === 'running';
  const services = [['google', 'Google', siGoogle], ['youtube', 'YouTube', siYoutube], ['github', 'GitHub', siGithub],
    ['openai', 'OpenAI', siOpenai], ['anthropic', 'Claude', siAnthropic]] as const;
  const quality = d.ipQuality;
  const qualityTone = d.ipQualityError ? 'bad' : quality?.risk === '高' || quality?.risk === '中' ? 'warn' : quality?.risk === '低' ? 'ok' : 'pending';
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setExpanded(false); toggleRef.current?.focus(); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [expanded]);
  return <>
    <section className="ov-panel services-card" aria-label="服务连通">
      <div className="ov-panel-head"><h2>服务连通</h2><span className="ov-probe-state">{busy ? '检测中' : !connected ? '连接后检测' : !Object.keys(d.serviceMap).length ? '待检测' : services.filter(([id]) => !d.serviceMap[id]?.ok).length ? '部分待确认' : '连接正常'}</span>
        <button type="button" className="icon-btn icon-btn-sm" title="刷新出口诊断" aria-label="刷新出口诊断" disabled={!connected || busy} onClick={d.runServiceProbe}>{busy ? <Spinner small /> : <IconRefresh size={13} />}</button>
      </div>
      <div className="service-tiles">{services.filter(([id]) => ['google', 'github', 'openai'].includes(id)).map(([id, name, icon]) => {
        const row = d.serviceMap[id];
        const tone = row ? row.ok ? 'ok' : row.status === 'error' ? 'warn' : 'bad' : 'pending';
        return <div className="service-tile" key={id} title={id === 'github' && githubNode ? `测速节点：${githubNode}` : row?.detail ?? undefined}>
          <span className="service-logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={icon.path} fill="currentColor" /></svg></span>
          <span className="service-name">{name}</span>
          <strong className={`service-latency diagnostic-status-${tone}`}>{row ? row.ok ? `${row.latency_ms ?? '—'} ms` : row.status === 'error' ? '异常' : '不可达' : busy ? '检测中' : '未测'}</strong>
        </div>;
      })}</div>
    </section>
    <div className="ov-evidence-note"><IconSecurity size={14} /><span>{connected ? '检测结果以当前路由为准' : '连接后可检查出口与防护'}</span>
      <button ref={toggleRef} type="button" className="icon-btn icon-btn-sm ov-evidence-toggle" aria-label={expanded ? '收起检测证据' : '查看检测证据'} title={expanded ? '收起检测证据' : '查看检测证据'} aria-expanded={expanded} aria-controls="diagnostic-details" onClick={() => setExpanded(value => !value)}><IconChevronRight size={15} /></button>
    </div>
    {expanded && <div id="diagnostic-details" className="ov-diagnostic-popover" role="region" aria-label="出口诊断详情">
    <header className="ov-evidence-heading">
      <div><h2>出口诊断</h2><span>{d.servicesAt ? `检测于 ${formatTime(d.servicesAt)}` : connected ? '等待检测' : '连接后检测'}</span></div>
      <button type="button" className="icon-btn" aria-label="关闭出口诊断" title="关闭出口诊断" onClick={() => { setExpanded(false); toggleRef.current?.focus(); }}><IconX size={15} /></button>
    </header>
    <section className="diag-card ip-quality-card" aria-label="IP 质量">
      <div className="diag-head">
        <div className="diag-heading"><div className="diag-title"><i className={`diag-dot ${qualityTone === 'ok' ? 'is-ok' : qualityTone === 'pending' ? '' : 'is-warn'}`} aria-hidden="true" />IP 质量</div></div>
        <div className="spacer" />
        <button type="button" className="icon-btn icon-btn-sm" title="重新检测 IP 质量" aria-label="重新检测 IP 质量" disabled={!connected || d.ipQualityLoading} onClick={d.loadIpQuality}>{d.ipQualityLoading ? <Spinner small /> : <IconRefresh size={13} />}</button>
      </div>
      <div className="ip-quality-main">
        <div className="ip-quality-value">
          <div className="ip-quality-kind">
            <strong>{quality?.kind ?? '待确认'}</strong>
            <span className={`diagnostic-status-${qualityTone}`}>{quality ? `${quality.risk}风险` : connected ? '等待检测' : '连接后检测'}</span>
          </div>
          <div className="ip-quality-rows">{[['ASN', quality?.asn], ['地区', quality?.country], ['运营商', quality?.isp ?? quality?.org]].map(([label, value]) => (
            <div className="ip-quality-row" key={label}><i>{label}</i><b title={value ?? undefined}>{value || '—'}</b></div>
          ))}</div>
        </div>
        <div className="ov-quality-ring" role="img" aria-label={quality && quality.risk !== '未知' ? `参考评分 ${quality.score} 分` : '参考评分待确认'} style={{ '--quality-score': `${quality && quality.risk !== '未知' ? Math.max(0, Math.min(100, quality.score)) : 0}%` } as React.CSSProperties}><b>{quality && quality.risk !== '未知' ? quality.score : '—'}<small>参考评分</small></b></div>
      </div>
      {d.ipQualityError && <span className="ov-quality-error" role="status" title={d.ipQualityError}>{d.ipQualityError}</span>}
    </section>
    <section className="diag-card protection-card" aria-label="泄漏检查">
      <div className="diag-head">
        <div className="diag-heading"><div className="diag-title">泄漏检查</div></div>
        <div className="spacer" />
        <PageLink page="security" label="安全设置" icon={<IconSecurity size={15} />} />
      </div>
      <div className="leak-rows">{[['ip', '出口 IP'], ['dns', 'DNS'], ['stun', 'STUN'], ['webrtc', 'WebRTC']].map(([id, label]) => {
        const row = d.leakRows.find(row => row.id === id);
        const status = row ? row.status === 'info' ? 'warn' : row.status : d.leakPhase === 'running' ? 'pending' : 'pending';
        return <div className="leak-row" key={id} title={row?.text}><i className={`leak-dot diagnostic-status-${status}`} aria-hidden="true" /><span className="leak-label">{label}</span><strong className={`diagnostic-status-${status}`}>{row?.text ?? (d.leakPhase === 'running' ? '检测中…' : '尚未检查')}</strong></div>;
      })}</div>
      {sysProxy && !tun && <p className="ov-diagnostic-note">系统代理不接管 UDP / WebRTC / DNS，建议开启 TUN</p>}
    </section>
      <section className="ov-evidence-services" aria-label="服务检测结果">
        <div className="ov-section-heading"><h3>服务连通</h3><span className="ov-diagnostic-note">仅检测连接，不代表账号权限或地区可用性</span></div>
        <div className="ov-diagnostic-detail-grid" role="list">{services.map(([id, name, icon]) => {
          const row = d.serviceMap[id];
          const tone = row ? row.ok ? 'ok' : row.status === 'error' ? 'warn' : 'bad' : 'pending';
          return <div className="ov-evidence-service-row" role="listitem" key={id}>
            <span className="ov-evidence-service-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d={icon.path} fill="currentColor" /></svg></span>
            <div className="ov-evidence-service-name"><strong>{name}</strong>{id === 'github' && githubNode && <span className="ov-evidence-service-route"><NodeName name={githubNode} /></span>}</div>
            <span className={`ov-evidence-service-value diagnostic-status-${tone}`}>{row ? row.ok ? `${row.latency_ms ?? '—'} ms` : row.status === 'error' ? '检测异常' : '不可达' : busy ? '检测中…' : '尚未检测'}</span>
            {row?.detail && <p className="ov-evidence-service-detail">{row.detail}</p>}
          </div>;
        })}</div>
      </section>
      <footer className="ov-evidence-scope"><span>IP 评分依据公开信息估算；WebRTC 仅检测本应用，STUN 依据内核运行规则检查。</span></footer>
    </div>}
  </>;
}
