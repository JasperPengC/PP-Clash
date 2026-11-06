import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Sidebar, type PageKey } from './components/Sidebar';
import { OverviewPage } from './pages/Overview';
import { ProxiesPage } from './pages/Proxies';
import { ConnectionsPage } from './pages/Connections';
import { RulesPage } from './pages/Rules';
import { LogsPage } from './pages/Logs';
import { OverridePage } from './pages/Override';
import { KernelPage } from './pages/Kernel';
import { ResourcesPage } from './pages/Resources';
import { TrafficPage } from './pages/Traffic';
import { DnsPage } from './pages/Dns';
import { SecurityPage } from './pages/Security';
import { ProfilesPage } from './pages/Profiles';
import { SettingsPage } from './pages/Settings';
import { resolveEffectiveGroup, useApp, type OutboundMode, type ToastKind } from './store/app';
import { STABLE_EGRESS_GROUP } from './core/generator';
import { api, isTauri } from './core/api';
import { IconAlert, IconCheck, IconDownload, IconInfo, IconX } from './components/icons';
import { WindowsTitlebar } from './components/WindowsTitlebar';
import { isWindows } from './core/platform';

const TOAST_TTL = 5000;

const PAGE_KEYS: PageKey[] = [
  'overview',
  'proxies',
  'connections',
  'security',
  'profiles',
  'rules',
  'logs',
  'override',
  'kernel',
  'resources',
  'traffic',
  'dns',
  'settings',
];

function initialPage(): PageKey {
  try {
    const page = new URLSearchParams(window.location.search).get('page');
    if (page && (PAGE_KEYS as string[]).includes(page)) return page as PageKey;
  } catch {
    /* ignore */
  }
  return 'overview';
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'success') return <IconCheck size={14} />;
  if (kind === 'error') return <IconAlert size={14} />;
  return <IconInfo size={14} />;
}

export default function App() {
  const [page, setPage] = useState<PageKey>(initialPage);
  const toast = useApp((s) => s.toast);
  const clearToast = useApp((s) => s.clearToast);
  const updateInfo = useApp((s) => s.updateInfo);
  const dismissUpdate = useApp((s) => s.dismissUpdate);
  const downloadUpdate = useApp((s) => s.downloadUpdate);
  const downloadingUpdate = useApp((s) => s.downloadingUpdate);
  const elevationPrompt = useApp((s) => s.elevationPrompt);
  const elevationBusy = useApp((s) => s.elevationBusy);
  const confirmElevation = useApp((s) => s.confirmElevation);
  const cancelElevation = useApp((s) => s.cancelElevation);

  // 托盘事件 → 前端状态。托盘在窗口隐藏时也可操作，这里是唯一的回传通道。
  useEffect(() => {
    if (!isTauri) return;
    const unlisteners = [
      listen('tray://node', () => {
        void useApp.getState().refreshGroups();
      }),
      listen<boolean>('tray://sysproxy', (e) => {
        useApp.getState().setSysProxyEnabled(e.payload);
      }),
      listen('tray://tun', () => {
        const s = useApp.getState();
        void s.setTun(!s.tunEnabled);
      }),
      listen<string>('tray://error', (e) => {
        useApp.getState().notify('error', e.payload);
      }),
      listen('tray://toggle-sysproxy', () => {
        const s = useApp.getState();
        void s.toggleSystemProxy(!s.sysProxyEnabled);
      }),
      listen('tray://toggle-tun', () => {
        const s = useApp.getState();
        void s.setTun(!s.tunEnabled);
      }),
      listen('tray://toggle-kernel', () => {
        const s = useApp.getState();
        if (s.kernelPhase === 'running') void s.stopKernel();
        else void s.startKernel();
      }),
      listen<boolean>('tray://panel-sysproxy', (e) => {
        void useApp.getState().toggleSystemProxy(e.payload);
      }),
      listen<string>('tray://panel-profile', (e) => {
        void useApp.getState().activate(e.payload);
      }),
      listen<{ group: string; node: string }>('tray://panel-node', (e) => {
        void useApp.getState().selectNode(e.payload.group, e.payload.node);
      }),
      listen<string>('tray://navigate', (e) => {
        const target = e.payload as PageKey;
        if (PAGE_KEYS.includes(target)) setPage(target);
      }),
      listen<string>('tray://mode', (e) => {
        const s = useApp.getState();
        const mode = e.payload as OutboundMode;
        if (!['rule', 'global', 'direct'].includes(mode)) return;
        s.updateSettings({ mode });
        void (async () => {
          const st = useApp.getState();
          await st.applyConfig();
          if (st.kernelPhase === 'running') {
            await st.restartKernel(true);
          }
        })();
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, []);

  // EmptyState / 引导按钮的跨页跳转
  useEffect(() => {
    const onNav = (e: Event) => {
      const target = (e as CustomEvent<string>).detail as PageKey;
      if (['overview', 'proxies', 'connections', 'security', 'profiles', 'rules', 'logs', 'override', 'kernel', 'resources', 'traffic', 'dns', 'settings'].includes(target)) {
        setPage(target);
      }
    };
    window.addEventListener('ppclash:nav', onNav);
    return () => window.removeEventListener('ppclash:nav', onNav);
  }, []);

  // 覆盖式悬浮滚动条：滚动时出现，700ms 后淡出，不占布局
  useEffect(() => {
    const thumbs = new Map<HTMLElement, { el: HTMLDivElement; timer: number }>();

    const hide = (target: HTMLElement, item: { el: HTMLDivElement; timer: number }) => {
      item.el.classList.remove('visible');
      if (!target.isConnected) {
        item.el.remove();
        thumbs.delete(target);
      }
    };

    const update = (target: HTMLElement) => {
      const maxScroll = target.scrollHeight - target.clientHeight;
      if (maxScroll < 2) {
        const existing = thumbs.get(target);
        if (existing) {
          existing.el.remove();
          thumbs.delete(target);
        }
        return;
      }

      let item = thumbs.get(target);
      if (!item) {
        const el = document.createElement('div');
        el.className = 'overlay-scrollbar';
        document.body.appendChild(el);
        item = { el, timer: 0 };
        thumbs.set(target, item);
      }

      const rect = target.getBoundingClientRect();
      const trackH = rect.height - 8;
      const ratio = target.clientHeight / target.scrollHeight;
      const thumbH = Math.max(26, trackH * ratio);
      const y = rect.top + 4 + (target.scrollTop / maxScroll) * (trackH - thumbH);

      item.el.style.height = `${thumbH}px`;
      item.el.style.transform = `translate3d(${rect.right - 9}px, ${y}px, 0)`;
      item.el.classList.add('visible');

      window.clearTimeout(item.timer);
      item.timer = window.setTimeout(() => hide(target, item), 700);
    };

    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof HTMLElement) update(target);
    };

    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      for (const item of thumbs.values()) item.el.remove();
      thumbs.clear();
    };
  }, []);

  // 节点故障自动切换：只对 Selector 组生效，URLTest 交给内核自动调度。
  const failoverBusy = useRef(false);
  const lastFailoverAt = useRef(0);
  useEffect(() => {
    if (!isTauri) return;
    const timer = window.setInterval(async () => {
      const s = useApp.getState();
      if (
        !s.settings.autoFailover ||
        s.kernelPhase !== 'running' ||
        !(s.sysProxyEnabled || s.tunEnabled) ||
        failoverBusy.current ||
        Date.now() - lastFailoverAt.current < 20_000
      ) {
        return;
      }
      const base = s.groups[0];
      const group = base ? resolveEffectiveGroup(s.groups, base.name) : undefined;
      if (!group || group.type !== 'Selector') return;
      const current = group.now;
      if (!current || !group.nodes.some((n) => n.name === current)) return;

      failoverBusy.current = true;
      try {
        const currentDelay = await s.testDelay(current);
        if (currentDelay != null && currentDelay > 0) return;
        const candidates = group.nodes.filter((n) => n.name !== current).slice(0, 6);
        if (candidates.length === 0) return;
        const tested = await Promise.all(
          candidates.map(async (n) => ({ node: n, delay: await s.testDelay(n.name) }))
        );
        const best = tested
          .filter((x): x is { node: (typeof candidates)[number]; delay: number } =>
            x.delay != null && x.delay > 0
          )
          .sort((a, b) => a.delay - b.delay)[0];
        if (!best) return;
        lastFailoverAt.current = Date.now();
        await s.selectNode(group.name, best.node.name);
        s.notify('info', `节点 ${current} 不可用，已切换到 ${best.node.name}`);
      } catch {
        /* 自动切换失败不打扰用户 */
      } finally {
        failoverBusy.current = false;
      }
    }, 20_000);
    return () => window.clearInterval(timer);
  }, []);

  // 侧栏版本号/关于入口点击检查更新
  useEffect(() => {
    const handle = () => void useApp.getState().checkUpdate(false);
    window.addEventListener('ppclash:check-update', handle);
    return () => window.removeEventListener('ppclash:check-update', handle);
  }, []);

  // GitHub 固定出口：只有连续 3 次探测失败才自动换节点。
  // 避免一次抖动就把登录 IP 切走；分组里保留全部节点，用户也可以手动切换。
  const kernelPhase = useApp((s) => s.kernelPhase);
  const egressGuard = useApp((s) => s.settings.egressGuard);
  const egressGuardNode = useApp((s) => s.settings.egressGuardNode);

  useEffect(() => {
    if (!isTauri || kernelPhase !== 'running' || !egressGuard || !egressGuardNode) return;
    let alive = true;
    let failures = 0;

    const check = async () => {
      if (!alive) return;
      const row = await api.probeService('github', egressGuardNode).catch(() => null);
      if (!alive) return;
      if (row?.ok) {
        failures = 0;
        return;
      }
      failures += 1;
      if (failures < 3) return;

      const state = useApp.getState();
      const group = state.groups.find((g) => g.name === STABLE_EGRESS_GROUP);
      const next = group?.nodes.map((n) => n.name).find((n) => n !== egressGuardNode);
      if (!next) {
        failures = 0;
        return;
      }
      try {
        await api.mihomo('PUT', `/proxies/${encodeURIComponent(STABLE_EGRESS_GROUP)}`, {
          name: next,
        });
      } catch {
        failures = 0;
        return;
      }
      state.updateSettings({ egressGuardNode: next });
      state.notify('info', `GitHub 出口连续失败 3 次，已自动切换到 ${next}`);
      failures = 0;
      await state.refreshGroups();
    };

    const first = window.setTimeout(() => void check(), 15_000);
    const timer = window.setInterval(() => void check(), 60_000);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [kernelPhase, egressGuard, egressGuardNode]);

  // 内核心跳：mihomo 可能自己退出（配置/端口/数据问题），
  // 前端不能一直显示「已连接」，否则用户会以为代理在跑但实际全网不通。
  useEffect(() => {
    if (!isTauri) return;
    let misses = 0;
    const timer = window.setInterval(() => {
      const s = useApp.getState();
      if (s.kernelPhase !== 'running') {
        misses = 0;
        return;
      }
      void api
        .kernelStatus(s.settings.controllerSecret)
        .then((st) => {
          if (st.running) {
            misses = 0;
            return;
          }
          // 连续两次探测失败才判定内核死亡，避免单次超时误杀
          misses += 1;
          if (misses >= 2) {
            misses = 0;
            void useApp.getState().handleKernelLost();
          }
        })
        .catch(() => {
          /* 单次探测异常不算数 */
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  // 订阅自动更新：每 10 分钟检查一次，按机场返回的更新间隔（缺省 24h）
  useEffect(() => {
    if (!isTauri) return;
    const check = () => {
      const s = useApp.getState();
      if (!s.settings.autoUpdate) return;
      const now = Date.now();
      for (const p of s.profiles) {
        if (p.autoUpdateHours === 0) continue;
        const hours = p.autoUpdateHours ?? p.updateIntervalHours ?? 24;
        if (hours > 0 && now - p.updatedAt > hours * 3_600_000) {
          void s.refreshProfile(p.id, true);
        }
      }
    };
    const timer = window.setInterval(check, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // 全局 toast：5 秒自动消退，点击立关
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, TOAST_TTL);
    return () => clearTimeout(t);
  }, [toast?.id, toast, clearToast]);

  return (
    <div className={`window-shell${isWindows ? ' is-windows' : ''}`}>
      {isWindows && <WindowsTitlebar />}
      <div className="app">
      <Sidebar current={page} onChange={setPage} />
      <main className="content">
        {updateInfo && (
          <div className="update-banner" role="status">
            <span className="update-banner-icon">
              <IconDownload size={14} />
            </span>
            <span className="update-banner-text">
              新版本 {updateInfo.version}
              {updateInfo.notes ? ` · ${updateInfo.notes}` : ''}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void api.openExternalUrl(updateInfo.url)}
            >
              查看更新
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={downloadingUpdate}
              onClick={() => void downloadUpdate()}
            >
              {downloadingUpdate ? '下载中…' : '下载更新'}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="关闭更新提示"
              onClick={dismissUpdate}
            >
              <IconX size={13} />
            </button>
          </div>
        )}
        {/* 概览常驻挂载：切换页面不再重置流量曲线/服务探测等状态 */}
        <div className="page-anim" style={{ display: page === 'overview' ? undefined : 'none' }}>
          <OverviewPage active={page === 'overview'} />
        </div>
        {page !== 'overview' && (
          <div key={page} className="page-anim">
            {page === 'proxies' && <ProxiesPage />}
            {page === 'connections' && <ConnectionsPage />}
            {page === 'rules' && <RulesPage />}
            {page === 'logs' && <LogsPage />}
            {page === 'override' && <OverridePage />}
            {page === 'kernel' && <KernelPage />}
            {page === 'resources' && <ResourcesPage />}
            {page === 'traffic' && <TrafficPage />}
            {page === 'dns' && <DnsPage />}
            {page === 'security' && <SecurityPage />}
            {page === 'profiles' && <ProfilesPage />}
            {page === 'settings' && <SettingsPage />}
          </div>
        )}

        {elevationPrompt && (
          <div className="modal-backdrop" role="presentation">
            <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="elevation-title">
              <div className="modal-title" id="elevation-title">开启 TUN 需要管理员权限</div>
              <div className="modal-desc">
                Windows 下创建虚拟网卡需要管理员权限。确认后应用会以管理员身份重启，
                重启后自动开启 TUN。
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={cancelElevation}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={elevationBusy}
                  onClick={() => void confirmElevation()}
                >
                  {elevationBusy ? '正在请求…' : '以管理员身份重启'}
                </button>
              </div>
            </div>
          </div>
        )}

        {toast && (
          <div className="toast-wrap">
            <button
              type="button"
              className={`toast ${toast.kind}`}
              onClick={clearToast}
              role="status"
              aria-live="polite"
            >
              <span className="toast-icon">
                <ToastIcon kind={toast.kind} />
              </span>
              <span style={{ userSelect: 'text' }}>{toast.text}</span>
            </button>
          </div>
        )}
      </main>
      </div>
    </div>
  );
}
