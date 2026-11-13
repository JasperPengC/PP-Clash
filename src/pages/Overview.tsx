import { useEffect, useMemo, useRef, useState } from 'react';
import { siGoogle, siYoutube, siGithub, siOpenai, siAnthropic } from 'simple-icons';
import { BrandCat } from '../components/BrandCat';
import { NodeName } from '../components/NodeName';
import { SplitSparkline } from '../components/visuals';
import { navigate, Segmented, Select, Spinner, Toggle } from '../components/ui';
import {
  IconBolt,
  IconCheck,
  IconChevronRight,
  IconDownload,
  IconRefresh,
  IconUpload,
} from '../components/icons';
import { getLifecycleToken, isLifecycleCurrent, primaryRoutingGroup, resolveActiveNode, resolveEffectiveGroup, useApp, type OutboundMode, type ProxyNode } from '../store/app';
import { api } from '../core/api';
import { useTakeoverStatus } from '../core/use-takeover-status';
import { findStableEgressGroup, STABLE_EGRESS_GROUP } from '../core/generator';
import { buildProxyDomain, proxyGroupKind, resolveProxyRoute } from '../core/proxy-domain';
import { useRouteDiagnostics } from '../core/use-diagnostics';
import { startPolling } from '../core/polling';
import { formatBytes, formatDuration, formatExpire, formatSpeed, formatTime } from '../core/format';
import { GITHUB_LATENCY_URL, groupLatencyTarget, latencyKey, normalizeLatency, readGroupLatency } from '../core/latency';

const EMPTY = Array.from({ length: 32 }, () => 0);
const OVERVIEW_NODE_HEIGHT = 44;
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
  const [inspectedGroup, setInspectedGroup] = useState<string | null>(null);
  const [nodeWindowStart, setNodeWindowStart] = useState(0);
  const nodeListRef = useRef<HTMLDivElement>(null);
  const [connCount, setConnCount] = useState<number | null>(null);
  const mixedPort = useApp((s) => s.settings.mixedPort);
  const toggleSystemProxy = useApp((s) => s.toggleSystemProxy);
  const setTun = useApp((s) => s.setTun);
  const selectNode = useApp((s) => s.selectNode);
  const testDelay = useApp((s) => s.testDelay);
  const refreshProfile = useApp((s) => s.refreshProfile);
  const refreshingIds = useApp((s) => s.refreshingIds);
  const activate = useApp((s) => s.activate);
  const notify = useApp((s) => s.notify);
  const updateSettings = useApp((s) => s.updateSettings);
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
  const [switchingMode, setSwitchingMode] = useState(false);
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
  const modeLock = useRef(false);
  const [pendingNode, setPendingNode] = useState<string | null>(null);
  const nodeLock = useRef(false);
  const changeMode = async (mode: OutboundMode) => {
    if (mode === settings.mode || modeLock.current) return;
    const token = getLifecycleToken();
    modeLock.current = true;
    setSwitchingMode(true);
    const previous = settings.mode;
    updateSettings({ mode });
    try {
      const st = useApp.getState();
      const applied = await st.applyConfig();
      if (!isLifecycleCurrent(token)) return;
      if (!applied) {
        updateSettings({ mode: previous });
        notify('error', '配置生成失败，出站模式未切换');
        return;
      }
      if (st.kernelPhase === 'running' && !await st.restartKernel(true, token, true)) {
        if (!isLifecycleCurrent(token)) return;
        if (useApp.getState().kernelPhase === 'running') {
          updateSettings({ mode: previous });
          useApp.setState({ configPath: '' });
          notify('error', '出站模式未能应用，继续使用原模式');
        } else notify('error', '模式已保存，但重新连接失败，请重试连接');
      }
    } catch (e) {
      if (!isLifecycleCurrent(token)) return;
      notify('error', `切换模式失败：${String(e)}`);
    } finally {
      modeLock.current = false;
      setSwitchingMode(false);
    }
  };

  const connected = kernelPhase === 'running';
  const takeover = useTakeoverStatus({ active, running: connected, sysProxy: sysProxyEnabled, tun: tunEnabled,
    revision: JSON.stringify([runtimeConfigRevision, connectedAt, settings.controllerPort, settings.controllerSecret]),
    transitioning: runtimeConfigTransition,
  });
  useEffect(() => { setInspectedGroup(null); }, [activeId]);
  useEffect(() => {
    testGroupEpoch.current += 1;
    testGroupLock.current = false;
    setGroupDelays({});
    setTestingGroup(false);
    return () => { testGroupEpoch.current += 1; };
  }, [activeId, connectedAt, connected, inspectedGroup]);
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
  const [proxyUp, setProxyUp] = useState<number[]>(EMPTY);
  const [proxyDown, setProxyDown] = useState<number[]>(EMPTY);
  const [directUp, setDirectUp] = useState<number[]>(EMPTY);
  const [directDown, setDirectDown] = useState<number[]>(EMPTY);
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
  const displayGroup = domain.groups.find(g => g.name === inspectedGroup)
    ?? domain.groups.find(g => g.name === effectiveGroup?.name) ?? domain.groups[0];
  useEffect(() => { setNodeWindowStart(0); if (nodeListRef.current) nodeListRef.current.scrollTop = 0; }, [displayGroup?.name, activeId]);

  useEffect(() => {
    if (!active) return;
    if (!connected) {
      setUp(EMPTY);
      setDown(EMPTY);
      setUpTotal(0);
      setDownTotal(0);
      setProxyUp(EMPTY);
      setProxyDown(EMPTY);
      setDirectUp(EMPTY);
      setDirectDown(EMPTY);
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
          setProxyUp((p) => [...p.slice(1), pu]);
          setProxyDown((p) => [...p.slice(1), pd]);
          setDirectUp((p) => [...p.slice(1), du]);
          setDirectDown((p) => [...p.slice(1), dd]);
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
  const peakUp = Math.max(...up);
  const peakDown = Math.max(...down);

  const githubGroups = runtimeMatches ? groups : domain.groups;
  const detectedGithubGroup = findStableEgressGroup(githubGroups)
    ?? githubGroups.find(group => group.name === STABLE_EGRESS_GROUP)?.name;
  const stableGithubNode = settings.mode === 'rule' && settings.egressGuard
    ? (detectedGithubGroup ? resolveActiveNode(groups, detectedGithubGroup) : settings.egressGuardNode)
    : '';

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

  const routeKey = JSON.stringify([routeRevision, connected, connectedAt, activeId, nodeName, settings.mode, tunEnabled, sysProxyEnabled, mixedPort, settings.dnsPort, stableGithubNode, blockWebRtc]);
  const diagnostics = useRouteDiagnostics({
    active, connected, routeKey, mixedPort, dnsPort: settings.dnsPort, tun: tunEnabled, githubNode: stableGithubNode, blockWebRtc,
  });
  const { egress, egressLoading, egressCountry } = diagnostics;

  const egressCountryLabel = useMemo(() => {
    if (!egressCountry) return null;
    if (egressCountry.code) {
      try {
        return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(egressCountry.code) ?? egressCountry.name;
      } catch {
        /* fall through */
      }
    }
    return egressCountry.name;
  }, [egressCountry]);


  const quota = activeProfile?.userinfo ?? null;
  const quotaUsed = quota ? quota.upload + quota.download : 0;
  const quotaRatio = quota && quota.total > 0 ? Math.min(quotaUsed / quota.total, 1) : 0;
  const quotaTone = quotaRatio >= 0.9 ? 'bad' : quotaRatio >= 0.7 ? 'warn' : 'ok';

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
        : '导入订阅';

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
  const egressFlag = egressCountryLabel ? (
    egressCountry?.code
      ? <span className={`fi fi-${egressCountry.code.toLowerCase()} ov-hero-flag`} role="img" aria-label={egressCountry.code} />
      : <span className="ov-hero-region">{egressCountryLabel}</span>
  ) : null;

  const visibleStart = Math.min(nodeWindowStart, Math.max(0, groupNodes.length - OVERVIEW_NODE_WINDOW));
  const visibleGroupNodes = groupNodes.slice(visibleStart, visibleStart + OVERVIEW_NODE_WINDOW);

  return (
    <>
      <header className="page-head ov-page-head">
        <div className="page-heading"><h1 className="page-title">概览</h1></div>
        <Segmented ariaLabel="出站模式" disabled={switchingMode}
          options={[{ value: 'rule', label: '规则' }, { value: 'global', label: '全局' }, { value: 'direct', label: '直连' }]}
          value={settings.mode} onChange={(value) => void changeMode(value)} />
      </header>
      <div className="page-scroll ov-scroll">
        <div className="ov-page">
          {connected && kernelError && <div className="banner warn ov-warning" role="alert"><span>{kernelError}</span></div>}
          <div className="ov-top-row">
            <section className={`ov-hero${connected ? ' is-up' : failed ? ' is-failed' : ''}`} aria-label="当前连接">
              <BrandCat size={150} className="ov-hero-cat" />
              <div className="ov-hero-top">
                <span className="ov-hero-state"><i className={`ov-hero-dot${connected ? ' is-running' : failed ? ' is-failed' : ''}`} aria-hidden="true" />{stateText}</span>
                <span className="ov-hero-uptime">{uptime ?? (kernelBusy ? '请稍候' : '尚未连接')}</span>
              </div>
              <div className="ov-hero-main">
                <strong className="ov-hero-node" title={connected ? actualConnection.name : desc}>{connected ? <NodeName name={actualConnection.name} /> : desc}</strong>
                <span className="ov-hero-route" title={actualConnection.auxiliaryLabel}>{connected ? actualConnection.auxiliaryLabel : failed ? kernelError ?? '内核未就绪' : '开启系统代理或 TUN 后连接'}</span>
              </div>
              <div className="ov-hero-egress"><span>出口</span><strong>{connected ? egress ?? (egressLoading ? '获取中' : '待确认') : '待确认'}</strong>{connected && egressFlag}</div>
              <div className="ov-hero-foot">
                <span><IconUpload size={12} />{formatBytes(connected ? upTotal : 0)}</span>
                <span><IconDownload size={12} />{formatBytes(connected ? downTotal : 0)}</span>
                <button type="button" className={`ov-latency hero-gauge ${actualConnection.tone}`} disabled={!actualConnection.canTest || testingCurrentNode || testingGroup}
                  aria-label={actualConnection.delay != null ? `测速当前节点，延迟 ${actualConnection.delay} 毫秒` : actualConnection.canTest ? '测速当前节点' : actualConnection.targetDescription}
                  title={actualConnection.targetDescription} onClick={() => void testCurrentNode()}>
                  <span className="ov-latency-reading">{actualConnection.testing ? <Spinner small /> : <IconRefresh size={12} />}<strong>{actualConnection.reading}</strong></span>
                </button>
              </div>
              {failed && <div className="ov-hero-actions"><button type="button" className="btn btn-primary btn-sm" disabled={retrying || kernelBusy} onClick={() => void retryConnection()}>{retrying ? '重试中…' : '重试连接'}</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('logs')}>查看日志</button></div>}
              {!connected && !activeProfile && <div className="ov-hero-actions"><button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('profiles')}>导入订阅</button></div>}
            </section>
            {(['up', 'down'] as const).map(direction => {
              const upload = direction === 'up';
              const rate = connected ? upload ? latestUp : latestDown : 0;
              return <section className={`ov-rate-card is-${direction}`} aria-label={upload ? '上传速率' : '下载速率'} key={direction}>
                <div className="ov-rate-head"><span className="ov-rate-title">{upload ? <IconUpload size={14} /> : <IconDownload size={14} />}{upload ? '上传' : '下载'}</span></div>
                <div className="ov-rate-figure"><strong>{formatSpeed(rate).split(' ')[0]}</strong><span>{formatSpeed(rate).split(' ')[1]}</span></div>
                <span className="ov-rate-peak">峰值 {formatSpeed(connected ? upload ? peakUp : peakDown : 0)}</span>
                <SplitSparkline proxy={upload ? proxyUp : proxyDown} direct={upload ? directUp : directDown} color={upload ? 'var(--up)' : 'var(--down)'} />
                <span className="ov-rate-total">本次 {formatBytes(connected ? upload ? upTotal : downTotal : 0)}</span>
              </section>;
            })}
          </div>
          <div className="ov-control-row">
            <section className="ov-takeover" aria-label="流量接管">
              <h2>流量接管</h2>
              <div className="ov-takeover-controls">
                <div className="ov-control"><span className="ov-control-copy"><strong>系统代理</strong><span>{proxyPending ? '处理中…' : kernelBusy ? '等待中…' : takeover.systemProxySubtitle}</span></span><Toggle on={sysProxyEnabled} busy={proxyPending} disabled={switchesBusy} onChange={value => void changeSystemProxy(value)} label="系统代理" /></div>
                <div className="ov-control"><span className="ov-control-copy"><strong>TUN 模式</strong><span>{tunPending ? '处理中…' : kernelBusy ? '等待中…' : takeover.tunSubtitle}</span></span><Toggle on={tunEnabled} busy={tunPending} disabled={switchesBusy} onChange={value => void changeTun(value)} label="TUN 模式" /></div>
              </div>
            </section>
            <section className="ov-subscription quota-card" aria-label="当前订阅">
              <div className="ov-section-heading"><h2>当前订阅</h2><button type="button" className="link-action" onClick={() => navigate('profiles')}>管理<IconChevronRight size={12} /></button></div>
              <div className="ov-subscription-main">
                <div className="ov-profile-name">{profiles.length > 1 && activeId ? <Select value={activeId} options={profiles.map(profile => ({ value: profile.id, label: profile.name }))} ariaLabel="切换订阅" className="ov-profile-select" onChange={id => void activate(id)} /> : <strong className="quota-card-name" title={activeProfile?.name}>{activeProfile?.name ?? '未导入订阅'}</strong>}<span>{activeProfile ? `更新于 ${formatTime(activeProfile.updatedAt)}` : '导入订阅后显示配额和节点'}</span></div>
                <div className="ov-quota-balance">{quota && quota.total > 0 ? <><span>剩余 <strong>{formatBytes(Math.max(quota.total - quotaUsed, 0))}</strong></span><span>{formatBytes(quotaUsed)} / {formatBytes(quota.total)}</span></> : <span>{activeProfile ? '暂无配额信息' : '尚未导入订阅'}</span>}</div>
                {activeId && <button type="button" className="icon-btn" title="更新当前订阅" aria-label="更新当前订阅" disabled={refreshingIds.includes(activeId)} onClick={() => void refreshProfile(activeId)}>{refreshingIds.includes(activeId) ? <Spinner small /> : <IconRefresh size={13} />}</button>}
              </div>
              {quota && quota.total > 0 && <div className="ov-quota-footer"><div className="ov-quota-progress" role="progressbar" aria-label="订阅配额已用" aria-valuenow={Math.round(quotaRatio * 100)} aria-valuemin={0} aria-valuemax={100}><span className={`ov-quota-fill is-${quotaTone}`} style={{ width: `${quotaRatio * 100}%` }} /></div><span>{quota.expire > 0 ? `到期 ${formatExpire(quota.expire)}` : '不限期'}</span></div>}
            </section>
          </div>
          <div className="ov-main-row">
            <section className="ov-traffic" aria-label="实时流量">
              <div className="ov-pane-head"><h2>实时流量</h2><span className="ov-meta">{connected && connCount != null ? `${connCount} 个连接` : '最近 32 秒'} · 代理 / 直连</span><button type="button" className="link-action" onClick={() => window.dispatchEvent(new CustomEvent('ppclash:nav', { detail: 'traffic' }))}>详情<IconChevronRight size={12} /></button></div>
              <div className="ov-traffic-chart">
                <div className="ov-traffic-series"><span><i className="ov-legend is-up" />上传</span><SplitSparkline proxy={proxyUp} direct={directUp} color="var(--up)" /></div>
                <div className="ov-traffic-series"><span><i className="ov-legend is-down" />下载</span><SplitSparkline proxy={proxyDown} direct={directDown} color="var(--down)" /></div>
              </div>
              <div className="ov-traffic-foot"><span><i className="ov-legend" />代理 ↑ {formatBytes(proxyUpBytes)}　↓ {formatBytes(proxyDownBytes)}</span><span><i className="ov-legend is-direct" />直连 ↑ {formatBytes(directUpBytes)}　↓ {formatBytes(directDownBytes)}</span></div>
            </section>
            <section className="ov-routing" aria-label="当前分组">
              <div className="ov-pane-head"><h2>当前分组{displayedLatencyTarget === GITHUB_LATENCY_URL && <span className="ov-meta" title={GITHUB_LATENCY_URL}> · GitHub 延迟</span>}</h2><button type="button" className="link-action" title="测速当前分组" aria-label="测速当前分组" disabled={!runtimeMatches || testingGroup || testingCurrentNode} onClick={() => void testCurrentGroup()}>{testingGroup ? <Spinner small /> : <IconBolt size={13} />}{testingGroup ? '测速中' : '测速'}</button></div>
              <div className="ov-group-picker"><select value={displayGroup?.name ?? ''} aria-label="浏览策略" disabled={!domain.groups.length} onChange={event => setInspectedGroup(event.target.value)}>{domain.groups.map(group => {
                const route = resolveProxyRoute(domain, group.name);
                const meaning = route.kind === 'multiple' ? '按连接分配' : route.kind === 'relay' ? '链式转发能力未核验' : proxyGroupKind(group.type);
                return <option value={group.name} key={group.name}>{group.name} · {meaning}</option>;
              })}{!domain.groups.length && <option value="">暂无分组</option>}</select>
                <span className="ov-meta">{displayGroup ? proxyGroupKind(displayGroup.type) : '暂无分组'}{!canSelectMember && displayGroup ? ' · 只读' : ''}{!connected && displayGroup ? ' · 订阅预览' : ''}</span>
              </div>
              <div id="overview-nodes" className="ov-nodes-body">
                <div ref={nodeListRef} className="ov-node-list" aria-label="当前分组候选" tabIndex={0}
                  onScroll={event => setNodeWindowStart(Math.max(0, Math.floor(event.currentTarget.scrollTop / OVERVIEW_NODE_HEIGHT) - 2))}>
                  {visibleStart > 0 && <div aria-hidden="true" style={{ height: visibleStart * OVERVIEW_NODE_HEIGHT }} />}
                  {visibleGroupNodes.map(node => {
                    const selected = connected && displayNow === node.name;
                    const ms = nodeLatency(node);
                    return <button key={node.name} type="button" className={`ov-node group-node${selected ? ' selected' : ''}`} title={node.name} aria-pressed={selected} disabled={!canSelectMember || pendingNode !== null} onClick={() => void onSelectNode(node.name)}>
                      <span className="ov-node-name"><NodeName name={node.name} /><span className="ov-node-type">{node.type}{selected && activeId && fixedNodes[activeId]?.[displayGroup!.name] === node.name ? ' · 固定' : ''}</span></span>
                      <span className="ov-node-status">{pendingNode === node.name ? <Spinner small /> : selected && <span className="ov-node-current"><IconCheck size={11} />当前</span>}<span className={`ov-node-delay${ms === null ? ' is-failed' : ''}`}>{ms === undefined ? '未测' : ms === null ? '失败' : `${ms} ms`}</span></span>
                    </button>;
                  })}
                  {groupNodes.length > visibleStart + visibleGroupNodes.length && <div aria-hidden="true" style={{ height: (groupNodes.length - visibleStart - visibleGroupNodes.length) * OVERVIEW_NODE_HEIGHT }} />}
                  {!groupNodes.length && <div className="ov-group-empty">{!activeProfile ? '导入订阅后显示节点' : displayGroup?.providers.some(provider => provider.state === 'error') ? '节点源读取失败，可在节点页重试' : displayGroup?.providers.some(provider => provider.state === 'waiting') ? '等待节点源加载' : '此分组暂无可见候选'}</div>}
                </div>
              </div>
              <button type="button" className="ov-all-nodes link-action" aria-label="查看全部节点" onClick={() => navigate('proxies')}>{groupNodes.length ? `全部 ${groupNodes.length} 个节点` : '全部节点'}<IconChevronRight size={12} /></button>
            </section>
          </div>
          <OverviewDiagnostics connected={connected} diagnostics={diagnostics} githubNode={stableGithubNode} />
        </div>
      </div>
    </>
  );
}

function OverviewDiagnostics({ connected, diagnostics: d, githubNode }: {
  connected: boolean; diagnostics: ReturnType<typeof useRouteDiagnostics>; githubNode: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const busy = d.egressLoading || d.servicesLoading || d.ipQualityLoading || d.leakPhase === 'running';
  const services = [['google', 'Google', siGoogle], ['youtube', 'YouTube', siYoutube], ['github', 'GitHub', siGithub],
    ['openai', 'ChatGPT', siOpenai], ['anthropic', 'Claude', siAnthropic]] as const;
  const quality = d.ipQuality;
  const qualityTone = d.ipQualityError ? 'bad' : quality?.risk === '高' || quality?.risk === '中' ? 'warn' : quality?.risk === '低' ? 'ok' : 'pending';
  const score = quality && quality.risk !== '未知' && Number.isFinite(quality.score) ? Math.max(0, Math.min(100, quality.score)) : null;
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setExpanded(false); toggleRef.current?.focus(); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [expanded]);
  return <div className="ov-diagnostic-row">
    <section className="ov-diagnostic-card" aria-label="服务连通">
      <div className="ov-section-heading"><h2>服务连通</h2><button type="button" className="icon-btn icon-btn-sm" title="刷新出口诊断" aria-label="刷新出口诊断" disabled={!connected || busy} onClick={d.runServiceProbe}>{busy ? <Spinner small /> : <IconRefresh size={13} />}</button></div>
      <div className="ov-service-list">{services.map(([id, name, icon]) => {
        const row = d.serviceMap[id];
        const tone = row ? row.ok ? 'ok' : row.status === 'error' ? 'warn' : 'bad' : 'pending';
        return <div className="ov-check-row service-tile" key={id} title={id === 'github' && githubNode ? `固定出口：${githubNode}` : row?.detail ?? undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={icon.path} fill="currentColor" /></svg><span>{name}{id === 'github' && githubNode && <small className="ov-service-fixed">固定出口</small>}</span>
          <strong className={`diagnostic-status-${tone}`}>{row ? row.ok ? `${row.latency_ms ?? '—'} ms` : row.status === 'error' ? '检测异常' : '不可达' : busy ? '检测中' : '未测'}</strong>
        </div>;
      })}</div>
    </section>
    <section className={`ov-diagnostic-card ov-quality diagnostic-status-${qualityTone}`} aria-label="IP 质量">
      <div className="ov-section-heading"><h2>IP 质量</h2><span className="ov-meta">{d.ipQualityLoading ? '检测中' : d.ipQualityError ? '检测失败' : quality ? '参考估算' : '待确认'}</span></div>
      <div className="ov-quality-main"><div><strong>{quality?.kind ?? '类型待确认'}</strong><span className={`diagnostic-status-${qualityTone}`}>{quality ? `${quality.risk}风险` : connected ? '等待检测' : '连接后检测'}</span></div>
        <div className="ov-quality-ring" role="img" aria-label={score === null ? '纯净度待确认' : `参考纯净度 ${score} 分`} style={{ '--quality-score': `${score ?? 0}%` } as React.CSSProperties}><b>{score ?? '—'}<small>纯净度</small></b></div>
      </div>
      <div className="ov-quality-foot">{[['ASN', quality?.asn], ['地区', quality?.country], ['运营商', quality?.isp ?? quality?.org]].map(([label, value]) => <span key={label} title={value ?? undefined}>{label}<b>{value || '待确认'}</b></span>)}</div>
      {d.ipQualityError && <span className="ov-quality-error" role="status" title={d.ipQualityError}>{d.ipQualityError}</span>}
    </section>
    <section className="ov-diagnostic-card" aria-label="泄漏检查">
      <div className="ov-section-heading diagnostics-heading"><h2>泄漏检查</h2><button ref={toggleRef} type="button" className="link-action" aria-expanded={expanded} aria-controls="diagnostic-details" onClick={() => setExpanded(value => !value)}>{expanded ? '收起详情' : '查看详情'}<IconChevronRight size={12} /></button></div>
      <div className="ov-leak-list">{[['ip', '出口'], ['dns', 'DNS'], ['webrtc', 'WebRTC']].map(([id, label]) => {
        const row = d.leakRows.find(row => row.id === id);
        return <div className="ov-check-row" key={id} title={row?.text}><span>{label}</span><strong className={`diagnostic-status-${row?.status === 'info' ? 'warn' : row?.status ?? 'pending'}`}>{row?.text ?? (d.leakPhase === 'running' ? '检测中' : '尚未检查')}</strong></div>;
      })}</div>
      <div className="ov-diagnostic-note">{d.leakRows.find(row => row.id === 'stun')?.text ?? '策略开启与检测结果分别确认'}</div>
    </section>
    {expanded && <div id="diagnostic-details" className="ov-diagnostic-popover" role="region" aria-label="出口诊断详情">
      <div className="ov-section-heading"><h2>出口诊断详情</h2><button type="button" className="btn btn-ghost btn-sm" onClick={() => { setExpanded(false); toggleRef.current?.focus(); }}>关闭</button></div>
      <p className="ov-diagnostic-note">服务仅检测连接，不检查账号权限或地区限制；IP 质量按公开信息估算。</p>
      <div className="ov-diagnostic-detail-grid">{services.map(([id, name]) => <div key={id}><strong>{name}{id === 'github' && githubNode ? ' · 固定出口' : ''}</strong><p>{d.serviceMap[id]?.detail || '尚无检测详情'}</p></div>)}</div>
      {d.ipQualityError && <p className="diagnostic-status-bad">{d.ipQualityError}</p>}
      <p className="ov-diagnostic-note">WebRTC 检测仅限本应用。STUN 防护按内核运行规则检查。</p>
      {d.leakRows.map(row => <div className="ov-check-row" key={row.id}><span>{row.label}</span><strong className={`diagnostic-status-${row.status === 'info' ? 'warn' : row.status}`}>{row.text}</strong></div>)}
      <button type="button" className="link-action" onClick={() => navigate('security')}>安全设置<IconChevronRight size={12} /></button>
    </div>}
  </div>;
}
