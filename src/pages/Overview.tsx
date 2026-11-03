import { useEffect, useMemo, useRef, useState } from 'react';
import { MiniSparkline, RouteTrafficChart } from '../components/visuals';
import { navigate, Pill, Segmented, Select, Toggle } from '../components/ui';
import {
  IconCheck,
  IconChevronRight,
  IconDownload,
  IconGlobe,
  IconProfiles,
  IconSecurity,
  IconTun,
  IconUpload,
} from '../components/icons';
import { resolveActiveNode, useApp, type OutboundMode } from '../store/app';
import { api } from '../core/api';
import { parseSubscriptionPreview } from '../core/subscription';
import { formatBytes, formatDuration, formatExpire, formatSpeed } from '../core/format';

const EMPTY = Array.from({ length: 32 }, () => 0);

export function OverviewPage() {
  const kernelPhase = useApp((s) => s.kernelPhase);
  const connectedAt = useApp((s) => s.connectedAt);
  const kernelError = useApp((s) => s.kernelError);
  const groups = useApp((s) => s.groups);
  const profiles = useApp((s) => s.profiles);
  const activeId = useApp((s) => s.activeId);
  const sysProxyEnabled = useApp((s) => s.sysProxyEnabled);
  const tunEnabled = useApp((s) => s.tunEnabled);
  const policy = useApp((s) => s.policy);
  const settings = useApp((s) => s.settings);
  const mixedPort = useApp((s) => s.settings.mixedPort);
  const toggleSystemProxy = useApp((s) => s.toggleSystemProxy);
  const setTun = useApp((s) => s.setTun);
  const selectNode = useApp((s) => s.selectNode);
  const activate = useApp((s) => s.activate);
  const notify = useApp((s) => s.notify);
  const updateSettings = useApp((s) => s.updateSettings);
  const [switchingMode, setSwitchingMode] = useState(false);

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
  const groupCardRef = useRef<HTMLElement | null>(null);
  const [groupSlots, setGroupSlots] = useState(5);
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
    ? primaryGroup
    : previewGroups[0]
      ? { name: previewGroups[0].name, now: '', nodes: previewGroups[0].nodes }
      : undefined;

  useEffect(() => {
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
  }, [connected]);

  // 出口 IP：连接后异步取一次，之后 60s 刷新
  useEffect(() => {
    if (!connected) {
      setEgress(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const r = await api.leakCheckIp(mixedPort);
        if (alive) setEgress(r.proxied ?? null);
      } catch {
        /* 拿不到就不显示 */
      }
    };
    void load();
    const t = window.setInterval(load, 60000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [connected, mixedPort]);

  // 运行时长计时
  useEffect(() => {
    if (!connected || !connectedAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [connected, connectedAt]);

  useEffect(() => {
    const el = groupCardRef.current;
    if (!el) return;
    const measure = () => {
      const nodes = el.querySelector('.group-nodes') as HTMLElement | null;
      const row = el.querySelector('.group-node') as HTMLElement | null;
      const avail = nodes?.clientHeight ?? 0;
      const rowH = row?.offsetHeight || 31;
      const count = Math.floor(avail / rowH);
      setGroupSlots(Math.max(3, Math.min(12, count)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const latestUp = up[up.length - 1] ?? 0;
  const latestDown = down[down.length - 1] ?? 0;
  const latestProxyUp = proxyUp[proxyUp.length - 1] ?? 0;
  const latestProxyDown = proxyDown[proxyDown.length - 1] ?? 0;
  const latestDirectUp = directUp[directUp.length - 1] ?? 0;
  const latestDirectDown = directDown[directDown.length - 1] ?? 0;
  const peakUp = Math.max(...up);
  const peakDown = Math.max(...down);

  const guards = [
    { key: 'DNS 防泄漏', on: policy.dnsLeakProtection },
    { key: 'WebRTC', on: policy.blockWebRtc },
    { key: 'IPv6 隔离', on: !policy.ipv6 },
    { key: 'TUN 严格路由', on: policy.tunStrictRoute },
  ];
  const goodCount = guards.filter((g) => g.on).length;
  const allGood = goodCount === guards.length;

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

  const modeLabel =
    settings.mode === 'global' ? '全局模式' : settings.mode === 'direct' ? '直连模式' : '规则模式';
  const desc = connected
    ? [modeLabel, primaryGroup?.now && primaryGroup.now !== nodeName ? primaryGroup.now : '']
        .filter(Boolean)
        .join(' · ')
    : failed
      ? (kernelError ?? '内核未就绪')
      : activeProfile
        ? '开启系统代理或 TUN'
        : '导入订阅';

  const uptime = connected && connectedAt ? formatDuration(now - connectedAt) : null;

  const groupNow = connected ? (primaryGroup?.now ?? '') : '';
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
    if (!connected || !primaryGroup) {
      notify('info', '先开启系统代理或 TUN');
      return;
    }
    void selectNode(primaryGroup.name, name);
  };

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">概览</h1>
        </div>
        <div className="page-actions">
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
          {switchingMode && <span className="card-hint">切换中…</span>}
        </div>
      </header>

      <div className="page-scroll">
        <div className="dash">
          {/* 连接主卡 */}
          <section className={`card hero-card span-6${connected ? ' on' : ' disconnected'}`}>
            <div className="hero-top">
              <div className="hero-main">
                <div className="hero-status-row">
                  <span className={`status-dot${connected ? ' on' : failed ? ' warn' : ''}`} />
                  <span className="status-text">{stateText}</span>
                  {uptime && <span className="hero-uptime">{uptime}</span>}
                  {connected && tunEnabled && <Pill tone="accent">TUN</Pill>}
                </div>

                <div className="hero-node">
                  {connected ? nodeName || '未选择节点' : failed ? '启动失败' : '未接管流量'}
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
                    <div className="hero-stat-label">出口 IP</div>
                    <div className="hero-stat-value" style={{ fontSize: 12.5 }}>
                      {connected ? egress ?? '—' : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="hero-stat-label">本次会话</div>
                    <div className="hero-stat-value" style={{ fontSize: 12.5 }}>
                      ↑{formatBytes(upTotal)} ↓{formatBytes(downTotal)}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 13 }}>
                  {connected && (
                    <button
                      type="button"
                      className="link-action"
                      onClick={() => navigate('proxies')}
                    >
                      切换节点
                      <IconChevronRight size={11} />
                    </button>
                  )}
                  {!activeProfile && (
                    <button
                      type="button"
                      className="link-action"
                      onClick={() => navigate('profiles')}
                    >
                      导入订阅
                      <IconChevronRight size={11} />
                    </button>
                  )}
                </div>
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
                  {proxyPending || (kernelBusy && !sysProxyEnabled)
                    ? '处理中…'
                    : sysProxyEnabled
                      ? '已开启'
                      : '未开启'}
                </div>
              </div>
              <Toggle
                on={sysProxyEnabled}
                busy={proxyPending || (kernelBusy && !sysProxyEnabled)}
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
                  {tunPending || (kernelBusy && !tunEnabled)
                    ? '处理中…'
                    : tunEnabled
                      ? '已开启'
                      : '未开启'}
                </div>
              </div>
              <Toggle
                on={tunEnabled}
                busy={tunPending || (kernelBusy && !tunEnabled)}
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
          <section ref={groupCardRef} className="card group-card span-4">
            <div className="group-head">
              <span className="section-title">{connected ? '当前分组' : '订阅节点'}</span>
              {displayGroup && <Pill tone={connected ? 'accent' : 'muted'}>{displayGroup.name}</Pill>}
              {!connected && <Pill tone="muted">预览</Pill>}
              <div className="spacer" />
              <button
                type="button"
                className="link-action"
                title="打开节点页"
                aria-label="打开节点页"
                onClick={() => navigate('proxies')}
              >
                全部
                <IconChevronRight size={11} />
              </button>
            </div>

            {groupNodes.length > 0 ? (
              <>
                <div className="group-nodes">
                {groupNodes.slice(0, groupSlots).map((node) => {
                  const selected = connected && groupNow === node.name;
                  const ms = node.delay;
                  return (
                    <button
                      key={node.name}
                      type="button"
                      className={`group-node${selected ? ' selected' : ''}`}
                      onClick={() => onSelectNode(node.name)}
                    >
                      <span className="group-node-name">{node.name}</span>
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

          {/* 防护状态 */}
          <section className="card protection-card span-12">
            <span className={`icon-tile ${allGood ? 'success' : 'warn'}`}>
              <IconSecurity size={16} />
            </span>
            <div className="protection-main">
              <div className="protection-title">
                {allGood ? '核心防护完整' : '防护有缺口'}
                <Pill tone={allGood ? 'ok' : 'warn'}>
                  {goodCount}/{guards.length}
                </Pill>
              </div>
              <div className="protection-sub">
                {allGood
                  ? 'DNS · WebRTC · IPv6 · TUN 严格路由'
                  : '有项目被关闭'}
              </div>
            </div>
            <div className="spacer" />
            <div className="protection-chips">
              {guards.map((g) => (
                <Pill key={g.key} tone={g.on ? 'ok' : 'muted'}>
                  {g.key}
                </Pill>
              ))}
            </div>
            <button
              type="button"
              className="link-action"
              onClick={() => navigate('security')}
            >
              安全设置
              <IconChevronRight size={11} />
            </button>
          </section>
        </div>
      </div>
    </>
  );
}
