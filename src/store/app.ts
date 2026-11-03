import { create } from 'zustand';
import { api, DATA_DIR, isTauri } from '../core/api';
import { generateConfig, type ConfigStats, type RuleEditState } from '../core/generator';
import type { AppUpdateInfo } from '../core/api';
import type { Finding } from '../core/audit';
import { DEFAULT_POLICY, type SecurityPolicy } from '../core/security';
import { countRealNodes, isInfoNode, parseSubscriptionMeta, type TrafficInfo } from '../core/subscription';
import { useTheme } from './theme';

export interface Profile {
  id: string;
  /** 优先用订阅响应头里的名字；没有则回落到 URL 主机名。 */
  name: string;
  url: string;
  raw: string;
  updatedAt: number;
  /** subscription-userinfo：已用 / 总量 / 到期时间。旧版本保存的订阅没有这个字段。 */
  userinfo: TrafficInfo | null;
  /** profile-update-interval（小时）。 */
  updateIntervalHours: number | null;
  /** 自动更新间隔：null = 跟随订阅；0 = 关闭；其它为小时。 */
  autoUpdateHours?: number | null;
  /** 更新订阅时走本机代理（需要内核运行）。 */
  useProxy?: boolean;
  /** 来源：远程订阅链接或本地文件；旧数据没有该字段时按 url 处理。 */
  sourceType?: 'url' | 'file';
  /** 订阅规则的启停/目标/排序覆盖。 */
  ruleEdits?: RuleEditState;
}

export interface CustomRule {
  id: string;
  type: string;
  payload: string;
  target: string;
  enabled: boolean;
}

export interface ProxyNode {
  name: string;
  type: string;
  delay: number | null;
}

export interface ProxyGroup {
  name: string;
  type: string;
  now: string;
  nodes: ProxyNode[];
}

export type ThemeMode = 'system' | 'light' | 'dark';

export type ToastKind = 'error' | 'success' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

/** 用户真正会改、且需要跨启动保留的偏好。 */
export interface AppSettings {
  theme: ThemeMode;
  /** 混合端口：系统/应用代理指向这里。 */
  mixedPort: number;
  /** mihomo 控制端口：前端经它读流量/延迟/切换节点。 */
  controllerPort: number;
  /** 自定义内核路径；留空则按优先级自动查找。 */
  kernelPath: string;
  /** 开机自启（macOS LaunchAgent）。 */
  launchAtLogin: boolean;
  /** 关窗最小化到托盘而不是退出。 */
  closeToTray: boolean;
  /** 出站模式：规则 / 全局 / 直连。 */
  mode: OutboundMode;
  /** 额外监听端口；0 表示关闭。 */
  socksPort: number;
  httpPort: number;
  redirPort: number;
  bindAddress: string;
  authUser: string;
  authPass: string;
  /** 允许局域网设备连接本机代理。 */
  allowLan: boolean;
  /** 进阶模式：显示规则、日志、覆写、内核等高级页面。 */
  advancedMode: boolean;
  traySpeed: boolean;
  /** 关闭窗口后隐藏 Dock 图标（菜单栏常驻）。 */
  hideDockOnClose: boolean;
  /** 设置结构版本，用于一次性迁移。 */
  settingsVersion: number;
  /** 内核 DNS 监听端口。 */
  dnsPort: number;
  /** DNS 服务器：自动（安全策略）/ 预设 DoH / 自定义。 */
  dnsNameserver: DnsNameserverMode;
  dnsCustom: string;
  /** 嗅探：从握手提取域名。 */
  snifferEnabled: boolean;
  snifferOverrideDestination: boolean;
  /** 订阅自动更新（按机场返回的 profile-update-interval，缺省 24h）。 */
  autoUpdate: boolean;
  /** 进阶覆写：多份 YAML/JS 文件，按顺序合并到生成配置。 */
  overrides: OverrideFile[];
  /** GitHub 下载代理前缀（下载内核/资源时使用，留空直连）。 */
  githubProxy: string;
  /** 自定义规则（插在防护规则之后、订阅规则之前）。 */
  customRules: CustomRule[];
  /** 应用更新 feed；留空关闭检查。 */
  updateFeedUrl: string;
  /** 启动时自动检查应用更新。 */
  updateCheckOnLaunch: boolean;
}

export type OutboundMode = 'rule' | 'global' | 'direct';
export type DnsNameserverMode = 'auto' | 'cloudflare' | 'google' | 'quad9' | 'custom';

export interface OverrideFile {
  id: string;
  name: string;
  mode: 'yaml' | 'js';
  enabled: boolean;
  text: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  mixedPort: 7890,
  controllerPort: 9090,
  kernelPath: '',
  launchAtLogin: false,
  closeToTray: true,
  mode: 'rule',
  allowLan: false,
  socksPort: 0,
  httpPort: 0,
  redirPort: 0,
  bindAddress: '127.0.0.1',
  authUser: '',
  authPass: '',
  advancedMode: true,
  traySpeed: true,
  hideDockOnClose: true,
  settingsVersion: 2,
  dnsPort: 1053,
  dnsNameserver: 'auto',
  dnsCustom: '',
  snifferEnabled: false,
  snifferOverrideDestination: false,
  autoUpdate: true,
  overrides: [],
  githubProxy: '',
  customRules: [],
  updateFeedUrl: '',
  updateCheckOnLaunch: true,
};

export type KernelPhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

interface AppStore {
  profiles: Profile[];
  activeId: string | null;
  updateInfo: AppUpdateInfo | null;
  checkingUpdate: boolean;
  downloadingUpdate: boolean;
  policy: SecurityPolicy;
  settings: AppSettings;
  tunEnabled: boolean;
  sysProxyEnabled: boolean;
  kernelPhase: KernelPhase;
  /** 本次连接开始时间（ms），用于概览显示运行时长。 */
  connectedAt: number | null;
  /** 最近一次内核启动/运行失败的原因，直接展示给用户。 */
  kernelError: string | null;
  groups: ProxyGroup[];
  audit: Finding[];
  stats: ConfigStats | null;
  toast: Toast | null;
  busy: boolean;
  /** 正在导入订阅。 */
  importing: boolean;
  /** 正在更新哪些订阅。 */
  refreshingIds: string[];

  /** 非持久化的派生路径：save_config 返回的绝对 config.yaml 与其所在目录。 */
  configPath: string;
  dataDir: string;

  /** 启动时从磁盘水合。 */
  hydrate: () => Promise<void>;
  importProfile: (url: string, useProxy?: boolean) => Promise<void>;
  /** 导入本地 YAML/JSON 文件；url 字段保存文件路径，便于后续重新读取。 */
  importProfileFile: (path: string) => Promise<void>;
  activate: (id: string) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  refreshProfile: (id: string, quiet?: boolean) => Promise<boolean>;
  /** 更新单个订阅的本地设置（自动更新间隔 / 是否走代理）。 */
  updateProfile: (id: string, patch: Partial<Profile>) => void;
  /** 更新当前活动订阅的规则编辑并立即应用。 */
  updateRuleEdits: (edits: RuleEditState) => Promise<void>;
  /** 调整订阅顺序（-1 上移，1 下移）。 */
  moveProfile: (id: string, dir: -1 | 1) => void;
  /** 拖拽排序：把 fromId 移到 toId 的位置。 */
  reorderProfiles: (fromId: string, toId: string) => void;
  applyConfig: () => Promise<void>;
  startKernel: (quiet?: boolean) => Promise<void>;
  stopKernel: (quiet?: boolean) => Promise<void>;
  /** 串行重启内核：避免多个配置修改同时 stop/start 互相踩踏。 */
  restartKernel: (quiet?: boolean) => Promise<boolean>;
  /** 彻底断开：停内核并清掉系统代理 / TUN 两个接管开关。 */
  disconnect: () => Promise<void>;
  /** 内核意外退出时由心跳探测调用：纠正 UI 状态并兜底关闭系统代理。 */
  handleKernelLost: () => Promise<void>;
  refreshGroups: (quiet?: boolean) => Promise<void>;
  selectNode: (group: string, node: string) => Promise<void>;
  testDelay: (node: string) => Promise<number | null>;
  toggleSystemProxy: (on: boolean) => Promise<void>;
  /** 托盘事件回写（只改状态并持久化，不再发系统调用）。 */
  setSysProxyEnabled: (on: boolean) => void;
  setTun: (on: boolean) => Promise<void>;
  setPolicy: (patch: Partial<SecurityPolicy>) => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => void;
  notify: (kind: ToastKind, text: string) => void;
  clearToast: () => void;
  checkUpdate: (silent?: boolean) => Promise<void>;
  downloadUpdate: () => Promise<void>;
  dismissUpdate: () => void;
}

function nameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() || path;
  return base.replace(/\.(ya?ml|json)$/i, '') || '本地订阅';
}

function nameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '未命名订阅';
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}

let restartChain: Promise<void> = Promise.resolve();
let recoveryToken = 0;
let recoveryRunning = false;
let configRevision = 0;
let validatedRevision = -1;

const GROUP_PRIORITY: Record<string, number> = {
  Selector: 0,
  URLTest: 1,
  Fallback: 2,
  LoadBalance: 3,
  Relay: 4,
};

function parseGroups(raw: any): ProxyGroup[] {
  const map = raw?.proxies ?? {};
  const out: ProxyGroup[] = [];

  for (const [name, info] of Object.entries<any>(map)) {
    // GLOBAL 是 mihomo 的全局兜底组，不是订阅分组：
    // 放进来会把「DIRECT / REJECT」当成当前节点顶到最前，概览和节点页都会显示错。
    if (name === 'GLOBAL') continue;
    if (!GROUP_PRIORITY[String(info?.type ?? '')] && !(info?.type in GROUP_PRIORITY)) continue;
    const nodes: ProxyNode[] = (info.all ?? [])
      // 机场喜欢把「剩余流量：1.91 TB」这类信息塞成节点，节点列表里要滤掉
      .filter((n: string) => !isInfoNode(n))
      .map((n: string) => {
        const d = map[n];
        const history = d?.history;
        const delay = Array.isArray(history) && history.length
          ? (history[history.length - 1]?.delay ?? null)
          : null;
        return { name: n, type: d?.type ?? '', delay };
      });
    out.push({ name, type: info.type, now: info.now ?? '', nodes });
  }

  // 主选择组优先（Selector 在前）；同类型里节点多的更可能是订阅主分组
  out.sort(
    (a, b) =>
      GROUP_PRIORITY[a.type] - GROUP_PRIORITY[b.type] ||
      b.nodes.length - a.nodes.length ||
      a.name.localeCompare(b.name)
  );
  return out;
}

/**
 * 分组里选中的可能还是另一个分组（例如「一毛机场」的当前项是「自动选择」）。
 * 一直往下追到真实节点，只用于展示；切换/选中判断仍然用原始 now。
 */
export function resolveActiveNode(groups: ProxyGroup[], name: string): string {
  let cur = name;
  const seen = new Set<string>();
  for (let i = 0; i < 8 && cur; i++) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const g = groups.find((x) => x.name === cur);
    if (!g) return cur;
    if (!g.now) return cur;
    cur = g.now;
  }
  return cur;
}

/** 把持久化切片写盘。落盘失败只记日志，绝不让内存态崩。 */
async function persist(s: AppStore) {
  if (!isTauri) return;
  const payload = JSON.stringify({
    profiles: s.profiles,
    activeId: s.activeId,
    policy: s.policy,
    settings: s.settings,
    tunEnabled: s.tunEnabled,
    sysProxyEnabled: s.sysProxyEnabled,
  });
  try {
    await api.saveAppState(payload, DATA_DIR);
  } catch (e) {
    console.error('[PPClash] 状态落盘失败', e);
  }
}

const runtimeOf = (s: AppStore) => ({
  mixedPort: s.settings.mixedPort,
  controllerPort: s.settings.controllerPort,
  controllerSecret: '',
  tunEnabled: s.tunEnabled,
  mode: s.settings.mode,
  allowLan: s.settings.allowLan,
  dnsPort: s.settings.dnsPort,
  socksPort: s.settings.socksPort,
  httpPort: s.settings.httpPort,
  redirPort: s.settings.redirPort,
  bindAddress: s.settings.bindAddress,
  authUser: s.settings.authUser,
  authPass: s.settings.authPass,
  dnsNameserver: s.settings.dnsNameserver,
  dnsCustom: s.settings.dnsCustom,
  snifferEnabled: s.settings.snifferEnabled,
  snifferOverrideDestination: s.settings.snifferOverrideDestination,
  customRules: s.settings.customRules,
  currentNode: resolveActiveNode(s.groups, s.groups[0]?.now ?? ''),
});

const overrideOf = (s: AppStore) =>
  s.settings.overrides
    .filter((o) => o.enabled)
    .map((o) => ({ mode: o.mode, text: o.text, name: o.name }));

/** 把前端状态推给托盘（更新勾选态并重建菜单）。失败静默，托盘不是关键路径。 */
async function pushTray(s: AppStore) {
  if (!isTauri) return;
  try {
    await api.setTrayFlags(
      s.tunEnabled,
      s.sysProxyEnabled,
      s.settings.mixedPort,
      s.settings.mode,
      s.settings.traySpeed,
      s.settings.hideDockOnClose
    );
  } catch (e) {
    console.error('[PPClash] 同步托盘失败', e);
  }
}

let toastSeq = 0;

export const useApp = create<AppStore>((set, get) => ({
  profiles: [],
  activeId: null,
  updateInfo: null,
  checkingUpdate: false,
  downloadingUpdate: false,
  policy: DEFAULT_POLICY,
  settings: DEFAULT_SETTINGS,
  tunEnabled: false,
  sysProxyEnabled: false,
  kernelPhase: 'stopped',
  connectedAt: null,
  kernelError: null,
  groups: [],
  audit: [],
  stats: null,
  toast: null,
  busy: false,
  importing: false,
  refreshingIds: [],
  configPath: '',
  dataDir: '',

  checkUpdate: async (silent = false) => {
    const url = get().settings.updateFeedUrl.trim();
    if (!isTauri || !url || get().checkingUpdate) return;
    set({ checkingUpdate: true });
    try {
      const info = await api.checkAppUpdate(url, '0.1.0');
      set({ updateInfo: info, checkingUpdate: false });
      if (!silent) {
        if (info) get().notify('info', `发现新版本 ${info.version}`);
        else get().notify('success', '已是最新版本');
      }
    } catch (e) {
      set({ checkingUpdate: false });
      if (!silent) get().notify('error', `检查更新失败：${errorText(e)}`);
    }
  },

  downloadUpdate: async () => {
    const info = get().updateInfo;
    if (!info || get().downloadingUpdate) return;
    set({ downloadingUpdate: true });
    try {
      const path = await api.downloadAppUpdate(info.url, info.sha256);
      await api.openDownloadedUpdate(path);
      get().notify('success', `更新包已下载：${info.version}`);
      set({ downloadingUpdate: false });
    } catch (e) {
      set({ downloadingUpdate: false });
      get().notify('error', `下载更新失败：${errorText(e)}`);
    }
  },

  dismissUpdate: () => set({ updateInfo: null }),

  notify: (kind, text) => {
    const cur = get().toast;
    // 同一条消息重复出现时不刷新，避免轮询失败把 toast 钉死
    if (cur && cur.kind === kind && cur.text === text) return;
    set({ toast: { id: ++toastSeq, kind, text } });
  },

  clearToast: () => set({ toast: null }),

  hydrate: async () => {
    if (!isTauri) return;
    try {
      const raw = await api.loadAppState(DATA_DIR);
      const saved = raw ? (JSON.parse(raw) as Partial<AppStore>) : {};

      const rawSettings = (saved.settings ?? {}) as Partial<AppSettings> &
        Record<string, unknown>;
      const settings: AppSettings = { ...DEFAULT_SETTINGS, ...rawSettings };
      // v2：进阶功能默认开启（老用户只迁移一次，之后尊重用户选择）
      const savedVersion = typeof rawSettings.settingsVersion === 'number'
        ? rawSettings.settingsVersion
        : 0;
      if (savedVersion < 2) {
        settings.advancedMode = true;
        settings.settingsVersion = 2;
      }
      // 兼容旧版单文件覆写（overrideEnabled / overrideMode / overrideText）
      if (!Array.isArray(settings.overrides)) settings.overrides = [];
      const rawRules = rawSettings.customRules;
      if (Array.isArray(rawRules)) {
        settings.customRules = rawRules.map((r: unknown, i: number) => {
          if (r && typeof r === 'object') {
            const o = r as Partial<CustomRule>;
            return {
              id: o.id ?? `rule-${i}`,
              type: o.type ?? 'DOMAIN-SUFFIX',
              payload: o.payload ?? '',
              target: o.target ?? 'DIRECT',
              enabled: o.enabled !== false,
            };
          }
          const line = String(r);
          const [type = 'DOMAIN-SUFFIX', payload = '', target = 'DIRECT'] = line
            .split(',')
            .map((x) => x.trim());
          return {
            id: `rule-${i}`,
            type: type || 'DOMAIN-SUFFIX',
            payload,
            target: target || 'DIRECT',
            enabled: true,
          };
        });
      } else {
        settings.customRules = [];
      }
      const legacyText = rawSettings.overrideText;
      if (settings.overrides.length === 0 && typeof legacyText === 'string' && legacyText.trim()) {
        settings.overrides = [
          {
            id: 'legacy',
            name: '覆写',
            mode: rawSettings.overrideMode === 'js' ? 'js' : 'yaml',
            enabled: Boolean(rawSettings.overrideEnabled),
            text: legacyText,
          },
        ];
      }
      const policy: SecurityPolicy = { ...DEFAULT_POLICY, ...(saved.policy ?? {}) };

      // 旧版 state.json 里的订阅没有 userinfo，这里补默认值，避免 UI 崩溃
      const profiles: Profile[] = (saved.profiles ?? []).map((p) => ({
        ...p,
        userinfo: p.userinfo ?? null,
        updateIntervalHours: p.updateIntervalHours ?? null,
      }));

      set({
        profiles,
        activeId: saved.activeId ?? null,
        policy,
        settings,
        tunEnabled: saved.tunEnabled ?? false,
        sysProxyEnabled: saved.sysProxyEnabled ?? false,
      });

      // 老版本导入的订阅没有订阅名和流量信息：后台补一次响应头（失败静默）
      const active = profiles.find((p) => p.id === saved.activeId);
      if (active && !active.userinfo) {
        void get().refreshProfile(active.id, true);
      }

      // 主题立即生效（与 theme store 同步）
      useTheme.getState().setMode(settings.theme);

      // 若仍有活动订阅，按当前策略/端口重建配置文件，保证磁盘与内存一致
      const stillValid =
        saved.activeId && (saved.profiles ?? []).some((p) => p.id === saved.activeId);
      if (stillValid) {
        await get().applyConfig();
      }

      // 内核可能在应用上次退出后仍在运行（或用户外部启动过），以实际探测为准
      const st = await api.kernelStatus().catch(() => null);
      if (st?.running) {
        set({ kernelPhase: 'running', connectedAt: Date.now() });
        await get().refreshGroups();
      } else {
        // 上次崩溃/强退可能留下 TUN 内核：不清掉会把系统流量继续劫持走
        void api.cleanupStaleKernel().catch(() => null);
      }

      // 系统代理的真实状态以 networksetup 为准（用户可能在系统设置里改过）
      const sp = await api.getSystemProxy().catch(() => null);
      if (sp) {
        set({ sysProxyEnabled: sp.enabled });
        if (sp.enabled && !st?.running) {
          if (sp.port === get().settings.mixedPort) {
            // 上次退出时内核被强杀/崩溃，系统代理指向了已经不存在的端口：
            // 这会表现为「电脑断网」，必须自动撤掉。
            await api
              .setSystemProxy(false, '127.0.0.1', get().settings.mixedPort)
              .catch(() => null);
            set({ sysProxyEnabled: false });
            get().notify('info', '已关闭遗留的系统代理');
          } else {
            // 别的客户端设置的代理不动它，只提示
            get().notify(
              'info',
              `系统代理指向 127.0.0.1:${sp.port}，连接后切换`
            );
          }
        }
      }

      // 关窗行为/托盘网速/Dock 设置需要同步到 Rust，否则重启后首帧使用旧默认值
      if (isTauri) {
        void api.setCloseToTray(settings.closeToTray).catch(() => null);
      }

      await pushTray(get());
      if (settings.updateCheckOnLaunch && settings.updateFeedUrl.trim()) {
        window.setTimeout(() => void get().checkUpdate(true), 1200);
      }
    } catch (e) {
      console.error('[PPClash] 水合失败', e);
      get().notify('error', `读取本地状态失败：${errorText(e)}`);
    }
  },

  importProfile: async (url, useProxy = false) => {
    if (!isTauri) {
      set({ toast: { id: ++toastSeq, kind: 'error', text: '浏览器预览模式无法拉取订阅，请用 npm run app 启动桌面端' } });
      return;
    }
    set({ busy: true, importing: true });
    try {
      const proxyPort =
        useProxy && get().kernelPhase === 'running' ? get().settings.mixedPort : undefined;
      if (useProxy && get().kernelPhase !== 'running') {
        get().notify('info', '内核未运行，直连导入');
      }
      const payload = await api.fetchSubscription(url, proxyPort);
      const meta = parseSubscriptionMeta(payload);
      const id = crypto.randomUUID();
      const profile: Profile = {
        id,
        // 机场在响应头里给的真名优先（如「一毛机场」），拿不到才用域名
        name: meta.name ?? nameFromUrl(url),
        url,
        raw: payload.raw,
        updatedAt: Date.now(),
        userinfo: meta.traffic,
        updateIntervalHours: meta.updateIntervalHours,
        autoUpdateHours: null,
        useProxy,
        sourceType: 'url',
      };
      const { audit, stats } = await generateConfig(
        payload.raw,
        get().policy,
        runtimeOf(get()),
        overrideOf(get())
      );
      set((s) => ({
        profiles: [...s.profiles, profile],
        // 导入新订阅不抢占当前订阅；只有还没有订阅时才自动激活
        activeId: s.activeId ?? id,
        audit,
        stats,
        busy: false,
        importing: false,
      }));
      await get().applyConfig();
      void persist(get());
      const realNodes = countRealNodes(payload.raw);
      get().notify(
        'success',
        `订阅已导入${meta.name ? ` · ${meta.name}` : ''}${realNodes ? ` · ${realNodes} 个节点` : ''}`
      );
    } catch (e) {
      set({ busy: false, importing: false });
      get().notify('error', `导入失败：${errorText(e)}`);
    }
  },

  importProfileFile: async (path) => {
    if (!isTauri) {
      set({ toast: { id: ++toastSeq, kind: 'error', text: '浏览器预览模式无法读取本地文件' } });
      return;
    }
    set({ busy: true, importing: true });
    try {
      const raw = await api.readSubscriptionFile(path);
      const id = crypto.randomUUID();
      const profile: Profile = {
        id,
        name: nameFromPath(path),
        url: path,
        raw,
        updatedAt: Date.now(),
        userinfo: null,
        updateIntervalHours: null,
        autoUpdateHours: 0,
        useProxy: false,
        sourceType: 'file',
      };
      const { audit, stats } = await generateConfig(raw, get().policy, runtimeOf(get()), overrideOf(get()));
      set((s) => ({
        profiles: [...s.profiles, profile],
        activeId: s.activeId ?? id,
        audit,
        stats,
        busy: false,
        importing: false,
      }));
      await get().applyConfig();
      void persist(get());
      const realNodes = countRealNodes(raw);
      get().notify(
        'success',
        `本地订阅已导入${realNodes ? ` · ${realNodes} 个节点` : ''}`
      );
    } catch (e) {
      set({ busy: false, importing: false });
      get().notify('error', `导入失败：${errorText(e)}`);
    }
  },

  activate: async (id) => {
    const p = get().profiles.find((x) => x.id === id);
    if (!p || get().activeId === id) return;
    const { audit, stats } = await generateConfig(
      p.raw,
      get().policy,
      runtimeOf(get()),
      overrideOf(get()),
      p.ruleEdits
    );
    set({ activeId: id, audit, stats });
    await get().applyConfig();
    void persist(get());
    // 切换订阅后让运行中的内核立刻使用新配置
    if (get().kernelPhase === 'running') {
      await get().restartKernel(true);
      get().notify('info', `已切换到 ${p.name}`);
    }
  },

  removeProfile: async (id) => {
    const wasActive = get().activeId === id;
    set((s) => ({
      profiles: s.profiles.filter((p) => p.id !== id),
      // 删掉活动订阅后配置链路失效，清空派生状态
      ...(wasActive ? { activeId: null, audit: [], stats: null, groups: [] } : {}),
    }));
    if (wasActive && get().kernelPhase === 'running') {
      await get().stopKernel(true);
      get().notify('info', '订阅已删除');
    }
    void persist(get());
  },

  updateProfile: (id, patch) => {
    set((s) => ({
      profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
    void persist(get());
  },

  updateRuleEdits: async (edits) => {
    const id = get().activeId;
    if (!id) return;
    set((s) => ({
      profiles: s.profiles.map((p) => (p.id === id ? { ...p, ruleEdits: edits } : p)),
    }));
    void persist(get());
    const st = get();
    await st.applyConfig();
    if (st.kernelPhase === 'running') {
      const ok = await st.restartKernel(true);
      if (!ok) return;
    }
    get().notify('success', '订阅规则已更新');
  },

  reorderProfiles: (fromId, toId) => {
    const profiles = [...get().profiles];
    const from = profiles.findIndex((p) => p.id === fromId);
    const to = profiles.findIndex((p) => p.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [item] = profiles.splice(from, 1);
    profiles.splice(to, 0, item);
    set({ profiles });
    void persist(get());
  },

  moveProfile: (id, dir) => {
    const profiles = [...get().profiles];
    const index = profiles.findIndex((p) => p.id === id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= profiles.length) return;
    [profiles[index], profiles[target]] = [profiles[target], profiles[index]];
    set({ profiles });
    void persist(get());
  },

  refreshProfile: async (id, quiet = false) => {
    const p = get().profiles.find((x) => x.id === id);
    if (!p) return false;
    if (!quiet) set({ busy: true });
    set((s) => ({
      refreshingIds: s.refreshingIds.includes(id) ? s.refreshingIds : [...s.refreshingIds, id],
    }));
    try {
      const useProxy = Boolean(p.useProxy);
      if (useProxy && get().kernelPhase !== 'running' && !quiet) {
        get().notify('info', '内核未运行，直连更新');
      }
      const proxyPort =
        useProxy && get().kernelPhase === 'running' ? get().settings.mixedPort : undefined;
      const payload =
        p.sourceType === 'file'
          ? {
              raw: await api.readSubscriptionFile(p.url),
              profileTitle: null,
              contentDisposition: null,
              subscriptionUserinfo: null,
              profileUpdateInterval: null,
            }
          : await api.fetchSubscription(p.url, proxyPort);
      const meta = parseSubscriptionMeta(payload);
      set((s) => ({
        profiles: s.profiles.map((x) =>
          x.id === id
            ? {
                ...x,
                name: meta.name ?? x.name,
                raw: payload.raw,
                userinfo: meta.traffic ?? x.userinfo,
                updateIntervalHours: meta.updateIntervalHours ?? x.updateIntervalHours,
                updatedAt: Date.now(),
              }
            : x
        ),
        busy: false,
        refreshingIds: s.refreshingIds.filter((x) => x !== id),
      }));
      // 活动中的订阅更新后立即重生成配置
      if (get().activeId === id) await get().applyConfig();
      void persist(get());
      if (!quiet) get().notify('success', '订阅已更新');
      return true;
    } catch (e) {
      set((s) => ({
        busy: quiet ? s.busy : false,
        refreshingIds: s.refreshingIds.filter((x) => x !== id),
      }));
      if (!quiet) get().notify('error', `更新失败：${errorText(e)}`);
      return false;
    }
  },

  applyConfig: async () => {
    const { activeId, profiles, policy, tunEnabled, settings } = get();
    const profile = profiles.find((p) => p.id === activeId);
    if (!profile) return;

    if (!isTauri) {
      // 浏览器预览：功能不可用是预期行为，不弹错误打扰看界面
      return;
    }

    set({ busy: true });
    try {
      const { config, audit, stats } = await generateConfig(
        profile.raw,
        policy,
        {
          mixedPort: settings.mixedPort,
          controllerPort: settings.controllerPort,
          controllerSecret: '',
          tunEnabled,
          mode: settings.mode,
          allowLan: settings.allowLan,
          dnsPort: settings.dnsPort,
          socksPort: settings.socksPort,
          httpPort: settings.httpPort,
          redirPort: settings.redirPort,
          bindAddress: settings.bindAddress,
          authUser: settings.authUser,
          authPass: settings.authPass,
          dnsNameserver: settings.dnsNameserver,
          dnsCustom: settings.dnsCustom,
          snifferEnabled: settings.snifferEnabled,
          snifferOverrideDestination: settings.snifferOverrideDestination,
        },
        overrideOf(get()),
        profile.ruleEdits
      );
      // save_config 返回绝对路径，直接拿来给内核用，避免相对路径错乱
      const absConfig = await api.saveConfig(config, DATA_DIR);
      const sep = absConfig.includes('\\') ? '\\' : '/';
      const absDir = absConfig.slice(0, absConfig.lastIndexOf(sep));
      configRevision += 1;
      set({ audit, stats, configPath: absConfig, dataDir: absDir, busy: false });
    } catch (e) {
      set({ busy: false });
      get().notify('error', `生成配置失败：${errorText(e)}`);
    }
  },

  startKernel: async (quiet = false) => {
    const phase = get().kernelPhase;
    if (phase === 'starting' || phase === 'stopping' || phase === 'running') return;
    if (!isTauri) {
      get().notify('error', '浏览器预览模式无法启动内核，请用 npm run app 启动桌面端');
      return;
    }

    let { configPath, dataDir } = get();
    if (!configPath) {
      const hasProfile = get().profiles.some((p) => p.id === get().activeId);
      if (!hasProfile) {
        get().notify('error', '还没有订阅，先在「订阅」页导入一份');
        return;
      }
      await get().applyConfig();
      ({ configPath, dataDir } = get());
      if (!configPath) return; // applyConfig 已经提示过失败原因
    }

    // 先用内核自检配置，避免坏配置把正在运行的内核停掉
    if (isTauri && configPath && validatedRevision !== configRevision) {
      try {
        await api.validateConfig(configPath, dataDir || DATA_DIR);
        validatedRevision = configRevision;
      } catch (e) {
        const msg = `配置校验失败：${errorText(e)}`;
        set({ kernelPhase: 'failed', connectedAt: null, kernelError: msg });
        get().notify('error', msg);
        return;
      }
    }

    set({ kernelPhase: 'starting', kernelError: null });
    if (!quiet) get().notify('info', '正在启动内核…');
    try {
      const st = await api.startKernel(
        configPath,
        dataDir || DATA_DIR,
        get().settings.kernelPath || null,
        get().tunEnabled,
        get().settings.controllerPort
      );
      if (st.running) {
        set({ kernelPhase: 'running', connectedAt: Date.now(), kernelError: null });
        recoveryToken += 1;
        if (st.reclaimed && st.reclaimed.length > 0) {
          get().notify('info', `已自动关闭 ${st.reclaimed.length} 个占用端口的进程`);
        }
        await get().refreshGroups();
        // 「连接」的语义是接管流量：非 TUN 模式下把系统代理指向本机端口。
        // 不管之前是否开着都重设一次，避免指向别的客户端遗留的旧端口。
        if (!get().tunEnabled) {
          try {
            const sp = await api.setSystemProxy(
              true,
              '127.0.0.1',
              get().settings.mixedPort
            );
            set({ sysProxyEnabled: sp.enabled });
            void persist(get());
          } catch (e) {
            get().notify('error', `内核已启动，但系统代理打开失败：${errorText(e)}`);
          }
        }
        if (!quiet) get().notify('success', '已连接');
      } else {
        const msg = '内核未就绪，请检查内核路径或配置';
        set({ kernelPhase: 'failed', connectedAt: null, kernelError: msg });
        if (!quiet) get().notify('error', msg);
      }
    } catch (e) {
      const msg = errorText(e);
      set({ kernelPhase: 'failed', connectedAt: null, kernelError: msg });
      if (!quiet) get().notify('error', `启动内核失败：${msg}`);
    }
    await pushTray(get());
  },

  handleKernelLost: async () => {
    if (get().kernelPhase !== 'running' || recoveryRunning) return;

    const wantedCapture = get().sysProxyEnabled || get().tunEnabled;
    set({
      kernelPhase: 'failed',
      connectedAt: null,
      kernelError: '内核已停止，详见 kernel.log',
      groups: [],
    });

    // 内核没了还留着系统代理 = 全网断线，静默撤掉
    if (get().sysProxyEnabled) {
      try {
        const sp = await api.setSystemProxy(false, '127.0.0.1', get().settings.mixedPort);
        set({ sysProxyEnabled: sp.enabled });
        void persist(get());
      } catch {
        /* 关不掉就下次再试 */
      }
    }

    if (wantedCapture) {
      recoveryRunning = true;
      const token = ++recoveryToken;
      get().notify('info', '内核已退出，正在恢复…');
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        if (get().kernelPhase === 'running' || token !== recoveryToken) break;
        await get().applyConfig();
        await get().startKernel(true);
        if (get().kernelPhase === 'running') {
          get().notify('success', '内核已自动恢复');
          break;
        }
        if (attempt === 3) {
          get().notify('error', '内核恢复失败，详见 kernel.log');
        }
      }
      recoveryRunning = false;
    } else {
      get().notify('error', '内核已停止，系统代理已关闭。');
    }
    await pushTray(get());
  },

  restartKernel: async (quiet = true) => {
    let ok = false;
    const run = restartChain.then(async () => {
      // 先重建并校验配置；校验失败就不要停掉正在工作的内核
      await get().applyConfig();
      const cfg = get().configPath;
      if (isTauri && cfg) {
        try {
          await api.validateConfig(cfg, get().dataDir || DATA_DIR);
          validatedRevision = configRevision;
        } catch (e) {
          get().notify('error', `配置校验失败：${errorText(e)}`);
          return;
        }
      }
      await get().stopKernel(true);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await new Promise((r) => setTimeout(r, attempt === 1 ? 400 : 1200 * attempt));
        await get().startKernel(true);
        if (get().kernelPhase === 'running') {
          ok = true;
          return;
        }
      }
    });
    restartChain = run.catch(() => undefined);
    await run;
    if (ok) {
      if (!quiet) get().notify('success', '内核已重启');
    } else {
      get().notify('error', '内核重启失败，详见 kernel.log');
    }
    return ok;
  },

  stopKernel: async (quiet = false) => {
    recoveryToken += 1;
    const phase = get().kernelPhase;
    if (phase === 'stopping') return;
    set({ kernelPhase: 'stopping' });

    // 先撤系统代理：内核停了还留着代理，会表现为「整个系统断网」。
    // 只撤指向本公司端口的代理，别误关其它客户端设置的代理。
    if (get().sysProxyEnabled) {
      const current = await api.getSystemProxy().catch(() => null);
      const pointingAtUs = !current || current.port === get().settings.mixedPort;
      if (pointingAtUs) {
        try {
          const sp = await api.setSystemProxy(false, '127.0.0.1', get().settings.mixedPort);
          set({ sysProxyEnabled: sp.enabled });
          void persist(get());
        } catch (e) {
          get().notify('error', `关闭系统代理失败：${errorText(e)}`);
        }
      }
    }

    try {
      await api.stopKernel();
    } catch {
      /* 已经停了 */
    }
    set({ kernelPhase: 'stopped', connectedAt: null, groups: [], kernelError: null });
    if (!quiet) get().notify('info', '已断开连接');
    await pushTray(get());
  },

  disconnect: async () => {
    await get().stopKernel();
    if (get().tunEnabled || get().sysProxyEnabled) {
      set({ tunEnabled: false, sysProxyEnabled: false });
      // 让下次启动使用非 TUN 配置
      await get().applyConfig();
      void persist(get());
      await pushTray(get());
    }
  },

  refreshGroups: async (quiet = true) => {
    if (!isTauri) return;
    try {
      const raw = await api.mihomo('GET', '/proxies');
      set({ groups: parseGroups(raw) });
    } catch (e) {
      if (!quiet) get().notify('error', `读取节点失败：${errorText(e)}`);
    }
  },

  selectNode: async (group, node) => {
    try {
      await api.mihomo('PUT', `/proxies/${encodeURIComponent(group)}`, { name: node });
      await get().refreshGroups();
    } catch (e) {
      get().notify('error', `切换节点失败：${errorText(e)}`);
    }
    await pushTray(get());
  },

  testDelay: async (node) => {
    try {
      const r: any = await api.mihomo(
        'GET',
        `/proxies/${encodeURIComponent(node)}/delay?url=${encodeURIComponent(
          'https://www.gstatic.com/generate_204'
        )}&timeout=5000`
      );
      return r?.delay ?? null;
    } catch {
      return null;
    }
  },

  toggleSystemProxy: async (on) => {
    if (!isTauri) {
      get().notify('error', '浏览器预览模式无法修改系统代理');
      return;
    }

    // 联动：开启系统代理即视为接管流量，内核没跑就先拉起
    if (on && get().kernelPhase !== 'running') {
      await get().startKernel();
      if (get().kernelPhase !== 'running') return;
    }

    try {
      const st = await api.setSystemProxy(on, '127.0.0.1', get().settings.mixedPort);
      set({ sysProxyEnabled: st.enabled });
      void persist(get());
      if (!on && !get().tunEnabled && get().kernelPhase === 'running') {
        await get().stopKernel(true);
        get().notify('info', '系统代理已关闭，内核已停止');
      } else {
        get().notify('info', on ? '系统代理已开启' : '系统代理已关闭');
      }
    } catch (e) {
      get().notify('error', `设置系统代理失败：${errorText(e)}`);
    }
    await pushTray(get());
  },

  setSysProxyEnabled: (on) => {
    set({ sysProxyEnabled: on });
    void persist(get());
    void pushTray(get());
  },

  setTun: async (on) => {
    if (!isTauri) {
      get().notify('error', '浏览器预览模式无法开启 TUN');
      return;
    }
    set({ tunEnabled: on });
    void persist(get());
    await pushTray(get());
    await get().applyConfig();

    if (on) {
      // TUN 接管全部流量，系统代理就多余了
      if (get().sysProxyEnabled) {
        try {
          const sp = await api.setSystemProxy(false, '127.0.0.1', get().settings.mixedPort);
          set({ sysProxyEnabled: sp.enabled });
        } catch {
          /* 忽略 */
        }
      }
      if (get().kernelPhase === 'running') {
        get().notify('info', 'TUN 已开启，正在重启内核…');
        await get().restartKernel(true);
      } else {
        // 联动：开 TUN 就自动拉起内核
        await get().startKernel();
        if (get().kernelPhase !== 'running') {
          set({ tunEnabled: false });
          await get().applyConfig();
        }
      }
      void persist(get());
      await pushTray(get());
      return;
    }

    // 关闭 TUN
    if (get().kernelPhase === 'running') {
      if (get().sysProxyEnabled) {
        get().notify('info', 'TUN 已关闭，正在重启内核…');
        await get().restartKernel(true);
      } else {
        await get().stopKernel(true);
        get().notify('info', 'TUN 已关闭，内核已停止');
      }
    } else {
      get().notify('info', 'TUN 已关闭');
    }
    void persist(get());
    await pushTray(get());
  },

  setPolicy: async (patch) => {
    set((s) => ({ policy: { ...s.policy, ...patch } }));
    void persist(get());
    // 先等配置落盘，再重启内核，避免 start 读到旧配置
    await get().applyConfig();
    if (get().kernelPhase === 'running') {
      const ok = await get().restartKernel(true);
      if (ok) get().notify('info', '安全策略已生效');
    }
  },

  updateSettings: (patch) => {
    const next: AppSettings = { ...get().settings, ...patch };
    set({ settings: next });

    // 主题即时生效
    if (patch.theme) useTheme.getState().setMode(patch.theme);

    // 跨启动的偏好同步到后端（失败不阻断 UI）
    if (patch.launchAtLogin !== undefined && isTauri) {
      void api
        .setLaunchLogin(patch.launchAtLogin)
        .catch((e) => console.error('[PPClash] 设置自启失败', e));
    }
    if (patch.closeToTray !== undefined && isTauri) {
      void api
        .setCloseToTray(patch.closeToTray)
        .catch((e) => console.error('[PPClash] 设置关窗行为失败', e));
    }
    if (
      patch.mode !== undefined ||
      patch.traySpeed !== undefined ||
      patch.hideDockOnClose !== undefined
    ) {
      void pushTray(get());
    }
    if (patch.mixedPort !== undefined) {
      void pushTray(get());
      // 系统代理指向的端口变了，立即改过去，否则旧端口会失效
      if (get().sysProxyEnabled && isTauri) {
        void api
          .setSystemProxy(true, '127.0.0.1', next.mixedPort)
          .catch((e) => console.error('[PPClash] 更新系统代理端口失败', e));
      }
    }

    void persist(get());
  },
}));

// 开发期调试钩子：浏览器预览时可在控制台模拟「已连接」状态，方便调 UI
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__ppclash = { useApp, useTheme };
}
