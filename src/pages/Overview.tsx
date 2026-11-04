import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeName } from '../components/NodeName';
import { MiniSparkline, RouteTrafficChart } from '../components/visuals';
import { navigate, Pill, Segmented, Select, Spinner, Toggle } from '../components/ui';
import {
  IconBolt,
  IconCheck,
  IconChevronRight,
  IconDownload,
  IconGlobe,
  IconProfiles,
  IconRefresh,
  IconSecurity,
  IconTun,
  IconUpload,
} from '../components/icons';
import { resolveActiveNode, resolveEffectiveGroup, useApp, type OutboundMode } from '../store/app';
import { api } from '../core/api';
import { parseSubscriptionPreview } from '../core/subscription';
import { checkWebRtc } from '../core/selfcheck';
import { formatBytes, formatDuration, formatExpire, formatSpeed, formatTime } from '../core/format';
import { siGoogle, siYoutube, siGithub, siOpenai, siAnthropic } from 'simple-icons';

const EMPTY = Array.from({ length: 32 }, () => 0);

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
}

const SERVICES = [
  { id: 'google', name: 'Google', icon: siGoogle, mono: false },
  { id: 'youtube', name: 'YouTube', icon: siYoutube, mono: false },
  { id: 'github', name: 'GitHub', icon: siGithub, mono: true },
  { id: 'openai', name: 'ChatGPT', icon: siOpenai, mono: true },
  { id: 'anthropic', name: 'Claude', icon: siAnthropic, mono: true },
] as const;


export function OverviewPage({ active = true }: { active?: boolean }) {
  const kernelPhase = useApp((s) => s.kernelPhase);
  const connectedAt = useApp((s) => s.connectedAt);
  const kernelError = useApp((s) => s.kernelError);
  const groups = useApp((s) => s.groups);
  const profiles = useApp((s) => s.profiles);
  const activeId = useApp((s) => s.activeId);
  const sysProxyEnabled = useApp((s) => s.sysProxyEnabled);
  const tunEnabled = useApp((s) => s.tunEnabled);
  const settings = useApp((s) => s.settings);
  const mixedPort = useApp((s) => s.settings.mixedPort);
  const toggleSystemProxy = useApp((s) => s.toggleSystemProxy);
  const setTun = useApp((s) => s.setTun);
  const selectNode = useApp((s) => s.selectNode);
  const refreshProfile = useApp((s) => s.refreshProfile);
  const refreshingIds = useApp((s) => s.refreshingIds);
  const activate = useApp((s) => s.activate);
  const notify = useApp((s) => s.notify);
  const updateSettings = useApp((s) => s.updateSettings);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [groupDelays, setGroupDelays] = useState<Record<string, number | null>>({});
  const [testingGroup, setTestingGroup] = useState(false);
  const [serviceMap, setServiceMap] = useState<
    Record<string, { ok: boolean; latency_ms: number | null }>
  >({});
  const [servicesLoading, setServicesLoading] = useState(false);
  const serviceProbeRunning = useRef(false);
  const [egressCountry, setEgressCountry] = useState<string | null>(null);
  const [egressLoading, setEgressLoading] = useState(false);
  const [leakPhase, setLeakPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [leakRows, setLeakRows] = useState<
    Array<{ id: string; label: string; status: 'ok' | 'warn' | 'bad' | 'info'; text: string }>
  >([]);

  const changeMode = async (mode: OutboundMode) => {
    if (mode === settings.mode) return;
    setSwitchingMode(true);
    updateSettings({ mode });
    const st = useApp.getState();
    await st.applyConfig();
    if (st.kernelPhase === 'running') {
      await st.restartKernel(true);
    }
    setSwitchingMode(false);
  };

  const connected = kernelPhase === 'running';
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
  const primaryGroup = groups[0];
  const effectiveGroup =
    connected && primaryGroup ? resolveEffectiveGroup(groups, primaryGroup.name) : undefined;
  const nodeName = resolveActiveNode(groups, primaryGroup?.now ?? '');

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
  const [latency, setLatency] = useState<number | null>(null);
  const [egress, setEgress] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const prev = useRef<{ up: number; down: number; ts: number } | null>(null);

  // 断开时先用订阅原文把节点画出来，和节点页保持一致
  const previewGroups = useMemo(
    () => parseSubscriptionPreview(activeProfile?.raw ?? ''),
    [activeProfile?.raw]
  );
  const displayGroup = connected
    ? effectiveGroup
    : previewGroups[0]
      ? { name: previewGroups[0].name, now: '', nodes: previewGroups[0].nodes }
      : undefined;

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
      setLatency(null);
      prev.current = null;
      prevConns.current = new Map();
      return;
    }

    let alive = true;

    const tick = async () => {
      try {
        const c: any = await api.mihomo('GET', '/connections');
        // mihomo 的 /connections 用 uploadTotal / downloadTotal，兼容旧字段名
        const u = c?.uploadTotal ?? c?.uploadTraffic ?? 0;
        const d = c?.downloadTotal ?? c?.downloadTraffic ?? 0;
        const ts = Date.now();
        if (prev.current) {
          const dt = (ts - prev.current.ts) / 1000;
          if (dt > 0) {
            const ur = Math.max(0, (u - prev.current.up) / dt);
            const dr = Math.max(0, (d - prev.current.down) / dt);
            if (alive) {
              setUp((p) => [...p.slice(1), ur]);
              setDown((p) => [...p.slice(1), dr]);
            }
          }
        }
        // 按连接链拆出「直连 / 代理」流量：逐连接做增量，避免连接关闭后字节数丢失
        const list: any[] = Array.isArray(c?.connections) ? c.connections : [];
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

    const tickGroups = () => {
      void useApp.getState().refreshGroups();
    };

    const testSelected = async () => {
      const node = useApp.getState().groups[0]?.now;
      if (!node) return;
      const d = await useApp.getState().testDelay(node);
      if (alive) setLatency(d);
    };

    void tick();
    tickGroups();
    void testSelected();
    const i1 = window.setInterval(tick, 1000);
    const i2 = window.setInterval(tickGroups, 3000);
    const i3 = window.setInterval(testSelected, 8000);

    return () => {
      alive = false;
      window.clearInterval(i1);
      window.clearInterval(i2);
      window.clearInterval(i3);
    };
  }, [connected, active]);

  // 出口 IP：连接后异步取一次；首轮失败自动重试，避免偶尔空白。
  useEffect(() => {
    if (!active) return;
    if (!connected) {
      setEgress(null);
      setEgressLoading(false);
      return;
    }
    let alive = true;
    const load = async () => {
      if (alive) setEgressLoading(true);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const r = await api.leakCheckIp(mixedPort);
          if (!alive) return;
          if (r.proxied) {
            setEgress(r.proxied);
            break;
          }
        } catch {
          /* 下一轮重试 */
        }
        await new Promise((resolve) => window.setTimeout(resolve, 800 * (attempt + 1)));
      }
      if (alive) setEgressLoading(false);
    };
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [connected, mixedPort, active]);

  // 出口 IP 归属地
  useEffect(() => {
    if (!active) return;
    if (!connected || !egress) {
      setEgressCountry(null);
      return;
    }
    let alive = true;
    void api
      .lookupIpCountry(egress)
      .then((r) => {
        if (alive) setEgressCountry(r.country);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [connected, egress, mixedPort]);

  // 运行时长计时
  useEffect(() => {
    if (!active || !connected || !connectedAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [connected, connectedAt, active]);



  const latestUp = up[up.length - 1] ?? 0;
  const latestDown = down[down.length - 1] ?? 0;
  const latestProxyUp = proxyUp[proxyUp.length - 1] ?? 0;
  const latestProxyDown = proxyDown[proxyDown.length - 1] ?? 0;
  const latestDirectUp = directUp[directUp.length - 1] ?? 0;
  const latestDirectDown = directDown[directDown.length - 1] ?? 0;
  const peakUp = Math.max(...up);
  const peakDown = Math.max(...down);

  const runServiceProbe = useCallback(async () => {
    if (!connected || serviceProbeRunning.current) return;
    serviceProbeRunning.current = true;
    setServicesLoading(true);
    // 每个服务独立请求，谁先返回谁先更新，不等待最慢的 ChatGPT。
    await Promise.all(
      SERVICES.map(async ({ id }) => {
        try {
          const row = await api.probeService(id);
          setServiceMap((prev) => ({ ...prev, [id]: row }));
        } catch {
          /* 单个失败保留旧结果 */
        }
      })
    );
    serviceProbeRunning.current = false;
    setServicesLoading(false);
  }, [connected]);

  useEffect(() => {
    if (!active) return;
    if (!connected || kernelBusy) {
      setServiceMap({});
      setServicesLoading(false);
      return;
    }
    // 首次接管后等内核和路由完全落稳再探测，避免刚启动时的假失败。
    // 这里不依赖 nodeName：URLTest 自动换节点时不能反复重置探测定时器。
    let alive = true;
    const start = window.setTimeout(() => {
      if (alive) void runServiceProbe();
    }, 3500);
    const timer = window.setInterval(() => {
      if (alive) void runServiceProbe();
    }, 30_000);
    return () => {
      alive = false;
      window.clearTimeout(start);
      window.clearInterval(timer);
    };
  }, [connected, kernelBusy, mixedPort, runServiceProbe, active]);

  const testCurrentGroup = async () => {
    if (!displayGroup || testingGroup) return;
    if (!connected) {
      notify('info', '先开启接管');
      return;
    }
    setTestingGroup(true);
    try {
      // 交给 mihomo 分组测速：服务端并发测完整组，避免前端逐个节点串行等待。
      const data = await api.mihomo(
        'GET',
        `/group/${encodeURIComponent(displayGroup.name)}/delay?url=${encodeURIComponent(
          'https://www.gstatic.com/generate_204'
        )}&timeout=5000`
      );
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        setGroupDelays((prev) => ({
          ...prev,
          ...(data as Record<string, number | null>),
        }));
      }
      await useApp.getState().refreshGroups(true);
    } catch (e) {
      notify('error', `分组测速失败：${errorText(e)}`);
    } finally {
      setTestingGroup(false);
    }
  };

  const runLeakCheck = useCallback(async () => {
    if (!connected) return;
    setLeakPhase('running');
    const [ip, dns, webrtc] = await Promise.all([
      api.leakCheckIp(mixedPort, tunEnabled).catch(() => null),
      api.leakCheckDns('www.apple.com', settings.dnsPort).catch(() => null),
      checkWebRtc(),
    ]);

    let ipRow: { status: 'ok' | 'warn' | 'bad' | 'info'; text: string };
    if (!ip) ipRow = { status: 'warn', text: '检测失败' };
    else if (!ip.proxied) ipRow = { status: 'warn', text: '代理端口不可达' };
    else if (tunEnabled) ipRow = { status: 'ok', text: `TUN 出口 ${ip.proxied}` };
    else if (ip.direct && ip.direct === ip.proxied)
      ipRow = { status: 'bad', text: `直连与代理出口相同（${ip.direct}）` };
    else ipRow = { status: 'ok', text: `代理出口 ${ip.proxied}` };

    let dnsRow: { status: 'ok' | 'warn' | 'bad' | 'info'; text: string };
    if (!dns) dnsRow = { status: 'warn', text: '检测失败' };
    else if (dns.system_fake_ip) dnsRow = { status: 'ok', text: '已接管（Fake-IP）' };
    else if (dns.kernel_alive && dns.kernel_fake_ip)
      dnsRow = { status: 'info', text: '内核正常；系统未接管' };
    else if (dns.kernel_alive) dnsRow = { status: 'info', text: '内核可达，未返回 Fake-IP' };
    else dnsRow = { status: 'warn', text: '内核 DNS 不可达' };

    let webRtcRow: { status: 'ok' | 'warn' | 'bad' | 'info'; text: string };
    if (!webrtc.supported) webRtcRow = { status: 'info', text: '当前环境不支持' };
    else if (webrtc.publicIps.length === 0) webRtcRow = { status: 'ok', text: '无公网候选' };
    else if (ip?.direct && webrtc.publicIps.includes(ip.direct))
      webRtcRow = { status: 'bad', text: `真实 IP ${webrtc.publicIps.join('、')}` };
    else if (ip?.proxied && webrtc.publicIps.every((x) => ip.proxied!.includes(x)))
      webRtcRow = { status: 'info', text: `代理 IP ${webrtc.publicIps.join('、')}` };
    else webRtcRow = { status: 'info', text: webrtc.publicIps.join('、') || '无候选' };

    setLeakRows([
      { id: 'ip', label: '出口 IP', ...ipRow },
      { id: 'dns', label: 'DNS 接管', ...dnsRow },
      { id: 'webrtc', label: 'WebRTC', ...webRtcRow },
    ]);
    setLeakPhase('done');
  }, [connected, mixedPort, settings.dnsPort, tunEnabled]);

  useEffect(() => {
    if (!active) return;
    if (!connected) {
      setLeakRows([]);
      setLeakPhase('idle');
      return;
    }
    const t = window.setTimeout(() => void runLeakCheck(), 2500);
    return () => window.clearTimeout(t);
  }, [connected, runLeakCheck, active]);

  const leakHasBad = leakRows.some((r) => r.status === 'bad');
  const leakHasWarn = leakRows.some((r) => r.status === 'warn');
  const leakTone = leakPhase !== 'done' ? 'muted' : leakHasBad ? 'bad' : leakHasWarn ? 'warn' : 'ok';

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

  const takeoverLabel = connected
    ? tunEnabled
      ? 'TUN 模式'
      : sysProxyEnabled
        ? '系统代理'
        : '未接管'
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

  const groupNow = connected ? (displayGroup?.now ?? '') : '';
  const groupNodes = displayGroup
    ? [...displayGroup.nodes].sort((a, b) => {
        // 已选中的节点永远排第一，其余按延迟升序
        const aSel = connected && a.name === groupNow;
        const bSel = connected && b.name === groupNow;
        if (aSel !== bSel) return aSel ? -1 : 1;
        const da = a.delay != null && a.delay > 0 ? a.delay : Number.MAX_SAFE_INTEGER;
        const db = b.delay != null && b.delay > 0 ? b.delay : Number.MAX_SAFE_INTEGER;
        if (da !== db) return da - db;
        return a.name.localeCompare(b.name);
      })
    : [];

  const onSelectNode = (name: string) => {
    if (!connected || !displayGroup) {
      notify('info', '先开启系统代理或 TUN');
      return;
    }
    void selectNode(displayGroup.name, name);
  };

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">概览</h1>
        </div>
        <div className="page-actions">
          <span className={`mode-switch-hint${switchingMode ? ' show' : ''}`}>切换中…</span>
          <Segmented
            ariaLabel="出站模式"
            options={[
              { value: 'rule', label: '规则' },
              { value: 'global', label: '全局' },
              { value: 'direct', label: '直连' },
            ]}
            value={settings.mode}
            onChange={(v) => void changeMode(v)}
          />
        </div>
      </header>

      <div className="page-scroll">
        <div className="dash">
          {/* 连接主卡 */}
          <section className={`card hero-card span-6${connected ? ' on' : ' disconnected'}`}>
            <div className="hero-top">
              <div className="hero-mode-tag">
                <Pill tone={connected && (tunEnabled || sysProxyEnabled) ? 'accent' : 'muted'}>
                  {takeoverLabel}
                </Pill>
              </div>
              <div className="hero-main">
                <div className="hero-status-row">
                  <span className={`status-dot${connected ? ' on' : failed ? ' warn' : ''}`} />
                  <span className="status-text">{stateText}</span>
                  {uptime && <span className="hero-uptime">{uptime}</span>}
                </div>

                <div className="hero-node">
                  {connected ? (
                    <NodeName name={nodeName || '未选择节点'} />
                  ) : failed ? (
                    '启动失败'
                  ) : (
                    '未接管流量'
                  )}
                </div>
                <div className="hero-sub">{desc}</div>

                <div className="hero-stats">
                  <div>
                    <div className="hero-stat-label">延迟</div>
                    <div className="hero-stat-value">
                      {connected && latency != null && latency > 0 ? (
                        <>
                          {latency}
                          <small>ms</small>
                        </>
                      ) : (
                        '—'
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="hero-stat-label">出口地址</div>
                    <div className="hero-stat-value" style={{ fontSize: 12.5 }}>
                      {connected ? egress ?? (egressLoading ? '获取中…' : '—') : '—'}
                      {connected && egressCountry && (
                        <small className="hero-country">{egressCountry}</small>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="hero-stat-label">本次会话</div>
                    <div className="hero-stat-value hero-session" style={{ fontSize: 12.5 }}>
                      <span>↑ {formatBytes(upTotal)}</span>
                      <span>↓ {formatBytes(downTotal)}</span>
                    </div>
                  </div>
                </div>

                {!activeProfile && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 13 }}>
                    <button
                      type="button"
                      className="link-action"
                      onClick={() => navigate('profiles')}
                    >
                      导入订阅
                      <IconChevronRight size={11} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* 上传 */}
          <section className="card stat-card span-3">
            <div className="stat-head">
              <span className="icon-tile up">
                <IconUpload size={15} />
              </span>
              上传
            </div>
            <div className="stat-number">{connected ? formatSpeed(latestUp) : '0 B/s'}</div>
            <div className="stat-meta">
              峰值 {connected ? formatSpeed(peakUp) : '0 B/s'} · 本次{' '}
              {connected ? formatBytes(upTotal) : '0 B'}
            </div>
            <MiniSparkline points={up} color="var(--up)" />
          </section>

          {/* 下载 */}
          <section className="card stat-card span-3">
            <div className="stat-head">
              <span className="icon-tile down">
                <IconDownload size={15} />
              </span>
              下载
            </div>
            <div className="stat-number">{connected ? formatSpeed(latestDown) : '0 B/s'}</div>
            <div className="stat-meta">
              峰值 {connected ? formatSpeed(peakDown) : '0 B/s'} · 本次{' '}
              {connected ? formatBytes(downTotal) : '0 B'}
            </div>
            <MiniSparkline points={down} color="var(--down)" />
          </section>

          {/* 系统代理 + TUN */}
          <section className="card switches-card span-6">
            <div className="switch-row">
              <span className={`icon-tile${sysProxyEnabled ? ' accent' : ''}`}>
                <IconGlobe size={15} />
              </span>
              <div className="switch-main">
                <div className="switch-title">系统代理</div>
                <div className="switch-sub">
                  {proxyPending
                    ? '处理中…'
                    : kernelBusy
                      ? '等待中…'
                      : sysProxyEnabled
                        ? '已开启'
                        : '未开启'}
                </div>
              </div>
              <Toggle
                on={sysProxyEnabled}
                busy={proxyPending}
                disabled={switchesBusy}
                onChange={(v) => void changeSystemProxy(v)}
                label="系统代理"
              />
            </div>
            <div className="switch-row">
              <span className={`icon-tile${tunEnabled ? ' accent' : ''}`}>
                <IconTun size={15} />
              </span>
              <div className="switch-main">
                <div className="switch-title">TUN 模式</div>
                <div className="switch-sub">
                  {tunPending
                    ? '处理中…'
                    : kernelBusy
                      ? '等待中…'
                      : tunEnabled
                        ? '已开启'
                        : '未开启'}
                </div>
              </div>
              <Toggle
                on={tunEnabled}
                busy={tunPending}
                disabled={switchesBusy}
                onChange={(v) => void changeTun(v)}
                label="TUN 模式"
              />
            </div>
          </section>

          {/* 订阅配额 */}
          <section className="card quota-card span-6">
            <div className="quota-card-head">
              <span className="icon-tile success">
                <IconProfiles size={15} />
              </span>
              {profiles.length > 1 && activeId ? (
                <Select
                  value={activeId}
                  options={profiles.map((p) => ({ value: p.id, label: p.name }))}
                  ariaLabel="切换订阅"
                  className="quota-profile-select"
                  onChange={(id) => void activate(id)}
                />
              ) : (
                <span className="quota-card-name">{quota ? activeProfile?.name : '未导入订阅'}</span>
              )}
              <div className="spacer" />
              {quota && quota.total > 0 && (
                <span className="quota-card-remain">
                  剩余 <b>{formatBytes(Math.max(quota.total - quotaUsed, 0))}</b>
                </span>
              )}
              <button
                type="button"
                className="link-action"
                onClick={() => navigate('profiles')}
              >
                管理
                <IconChevronRight size={11} />
              </button>
            </div>

            {quota && quota.total > 0 ? (
              <>
                <div className="progress">
                  <span
                    className={`progress-fill ${quotaTone}`}
                    style={{ width: `${quotaRatio * 100}%` }}
                  />
                </div>
                <div className="quota-card-foot">
                  <span>
                    已用 {formatBytes(quotaUsed)} / {formatBytes(quota.total)}
                  </span>
                  <span>·</span>
                  <span>{quota.expire > 0 ? `${formatExpire(quota.expire)} 到期` : '不限期'}</span>
                  <div className="spacer" />
                  <span>{(quotaRatio * 100).toFixed(1)}%</span>
                </div>
              </>
            ) : (
              <div className="quota-card-foot">
                <span className="quota-empty">
                  {activeProfile
                    ? '暂无配额信息'
                    : '导入订阅后显示'}
                </span>
                <div className="spacer" />
                {!activeProfile && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => navigate('profiles')}
                  >
                    去导入
                  </button>
                )}
              </div>
            )}
            <div className="quota-updated">
              <span>
                {activeProfile
                  ? `更新于 ${formatTime(activeProfile.updatedAt)}`
                  : '尚未导入订阅'}
              </span>
              <div className="spacer" />
              {activeId && (
                <button
                  type="button"
                  className="icon-btn quota-refresh"
                  title="更新当前订阅"
                  aria-label="更新当前订阅"
                  disabled={refreshingIds.includes(activeId)}
                  onClick={() => void refreshProfile(activeId)}
                >
                  {refreshingIds.includes(activeId) ? (
                    <Spinner small />
                  ) : (
                    <IconRefresh size={12} />
                  )}
                </button>
              )}
            </div>
          </section>

          {/* 流量曲线 */}
          <section className="card chart-card span-8">
            <div className="chart-head">
              <span className="section-title">实时流量</span>
              <div className="spacer" />
              <div className="legend">
                <span className="legend-item" style={{ color: 'var(--up)' }}>
                  <span className="legend-swatch" />
                  代理↑ {connected ? formatSpeed(latestProxyUp) : '0 B/s'}
                </span>
                <span className="legend-item" style={{ color: 'var(--down)' }}>
                  <span className="legend-swatch" />
                  代理↓ {connected ? formatSpeed(latestProxyDown) : '0 B/s'}
                </span>
                <span className="legend-item" style={{ color: 'var(--up)', opacity: 0.55 }}>
                  <span className="legend-swatch" />
                  直连↑ {connected ? formatSpeed(latestDirectUp) : '0 B/s'}
                </span>
                <span className="legend-item" style={{ color: 'var(--down)', opacity: 0.55 }}>
                  <span className="legend-swatch" />
                  直连↓ {connected ? formatSpeed(latestDirectDown) : '0 B/s'}
                </span>
              </div>
            </div>

            <RouteTrafficChart
              proxyUp={proxyUp}
              proxyDown={proxyDown}
              directUp={directUp}
              directDown={directDown}
            />

            <div className="card-foot">
              <span className="card-hint">
                代理 ↑{connected ? formatBytes(proxyUpBytes) : '0 B'} ↓
                {connected ? formatBytes(proxyDownBytes) : '0 B'} · 直连 ↑
                {connected ? formatBytes(directUpBytes) : '0 B'} ↓
                {connected ? formatBytes(directDownBytes) : '0 B'}
              </span>
              <div className="spacer" />
              <span className="card-hint">最近 32 秒</span>
            </div>
          </section>

          {/* 当前分组 */}
          <section className="card group-card span-4">
            <div className="group-head">
              <span className="section-title">{connected ? '当前分组' : '订阅节点'}</span>
              {displayGroup && <Pill tone={connected ? 'accent' : 'muted'}>{displayGroup.name}</Pill>}
              {!connected && <Pill tone="muted">预览</Pill>}
              <div className="spacer" />
              <button
                type="button"
                className="link-action group-test-link"
                title="测速当前分组"
                aria-label="测速当前分组"
                disabled={!connected || testingGroup}
                onClick={() => void testCurrentGroup()}
              >
                {testingGroup ? <Spinner small /> : <IconBolt size={12} />}
                测速
              </button>
            </div>

            {groupNodes.length > 0 ? (
              <>
                <div className="group-nodes-scroll">
                {groupNodes.map((node) => {
                  const selected = connected && groupNow === node.name;
                  const ms = groupDelays[node.name] ?? node.delay;
                  return (
                    <button
                      key={node.name}
                      type="button"
                      className={`group-node${selected ? ' selected' : ''}`}
                      onClick={() => onSelectNode(node.name)}
                    >
                      <span className="group-node-name"><NodeName name={node.name} /></span>
                      {selected ? (
                        <span className="group-node-check">
                          <IconCheck size={12} />
                        </span>
                      ) : (
                        connected &&
                        ms != null &&
                        ms > 0 && (
                          <span className="delay" style={{ minWidth: 42, fontSize: 10.5 }}>
                            {ms} ms
                          </span>
                        )
                      )}
                    </button>
                  );
                })}
                </div>
              </>
            ) : (
              <div className="group-empty">
                {!activeProfile ? '导入订阅后显示节点' : '开启接管后显示'}
                {!activeProfile && (
                  <div style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => navigate('profiles')}
                    >
                      导入订阅
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 服务连通 */}
          <section className="card service-card span-12">
            <div className="service-head">
              <span className="service-lead-icon">
                <IconGlobe size={15} />
              </span>
              <div className="service-heading">
                <span className="service-title">服务连通</span>
                <span className="service-sub">
                  {connected
                    ? servicesLoading
                      ? Object.keys(serviceMap).length
                        ? '更新中…'
                        : '检测中…'
                      : '经当前出口探测'
                    : '接管后检测'}
                </span>
              </div>
              <div className="spacer" />
              <button
                type="button"
                className="icon-btn service-refresh"
                title="重新测试连通性"
                aria-label="重新测试连通性"
                disabled={!connected || servicesLoading}
                onClick={() => void runServiceProbe()}
              >
                {servicesLoading ? <Spinner small /> : <IconRefresh size={13} />}
              </button>
            </div>
            <div className="service-grid">
              {SERVICES.map(({ id, name, icon, mono }) => {
                const row = serviceMap[id];
                const state = !connected
                  ? 'pending'
                  : row
                    ? row.ok
                      ? 'ok'
                      : 'bad'
                    : servicesLoading
                      ? 'pending'
                      : 'bad';
                return (
                  <div className={`service-tile ${state}`} key={id}>
                    <span
                      className="service-logo"
                      style={{ color: mono ? 'var(--text-1)' : `#${icon.hex}` }}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d={icon.path} fill="currentColor" />
                      </svg>
                    </span>
                    <div className="service-info">
                      <span className="service-name">{name}</span>
                      <span className="service-latency">
                        {!connected
                          ? '未接管'
                          : row
                            ? row.ok
                              ? `${row.latency_ms ?? '—'} ms`
                              : '不可达'
                            : servicesLoading
                              ? '检测中…'
                              : '—'}
                      </span>
                    </div>
                    <span className={`service-dot ${state}`} />
                  </div>
                );
              })}
            </div>
          </section>

          {/* 泄露检查 */}
          <section className="card protection-card span-12">
            <div className="protection-head">
              <span
                className={`protection-lead-icon ${
                  leakPhase !== 'done' ? '' : leakHasBad ? 'bad' : leakHasWarn ? 'warn' : 'ok'
                }`}
              >
                <IconSecurity size={15} />
              </span>
              <div className="protection-heading">
                <div className="protection-title">
                  泄露检查
                  {leakPhase === 'done' && (
                    <Pill tone={leakTone === 'ok' ? 'ok' : leakTone === 'bad' ? 'bad' : leakTone === 'warn' ? 'warn' : 'muted'}>
                      {leakHasBad ? '有泄漏风险' : leakHasWarn ? '部分未通过' : '通过'}
                    </Pill>
                  )}
                </div>
                <div className={`protection-sub${sysProxyEnabled && !tunEnabled ? ' warn' : ''}`}>
                  {sysProxyEnabled && !tunEnabled
                    ? '系统代理不接管 UDP / WebRTC / DNS，建议开启 TUN'
                    : leakPhase === 'running'
                      ? '正在实测出口 / DNS / WebRTC…'
                      : leakPhase === 'done'
                        ? '出口 IP · DNS 接管 · WebRTC'
                        : '接管后自动检测'}
                </div>
              </div>
              <div className="spacer" />
              <button
                type="button"
                className="icon-btn"
                title="重新检测"
                aria-label="重新检测"
                disabled={!connected || leakPhase === 'running'}
                onClick={() => void runLeakCheck()}
              >
                {leakPhase === 'running' ? <Spinner small /> : <IconRefresh size={13} />}
              </button>
              <button
                type="button"
                className="link-action"
                onClick={() => navigate('security')}
              >
                安全设置
                <IconChevronRight size={11} />
              </button>
            </div>
            <div className="protection-grid leak-grid">
              {(leakRows.length > 0
                ? leakRows
                : [
                    { id: 'ip', label: '出口 IP', status: 'info' as const, text: connected ? '检测中…' : '未接管' },
                    { id: 'dns', label: 'DNS 接管', status: 'info' as const, text: connected ? '检测中…' : '未接管' },
                    { id: 'webrtc', label: 'WebRTC', status: 'info' as const, text: connected ? '检测中…' : '未接管' },
                  ]
              ).map((row) => (
                <div className={`protection-tile ${row.status}`} key={row.id}>
                  <span className={`protection-dot ${row.status}`} />
                  <span className="protection-name">{row.label}</span>
                  <span className="protection-state">{row.text}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
