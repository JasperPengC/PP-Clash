import { invoke } from '@tauri-apps/api/core';

/** 是否运行在 Tauri 里。浏览器里跑（纯前端预览）时用 mock，避免 invoke 直接抛错。 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * 设计预览模式：`npm run dev` 后访问 `/?preview=connected`。
 * 只在开发构建里生效，生产构建中被静态剔除；用于在没有内核的环境下检查「已连接」态 UI。
 */
export const previewMode =
  !isTauri &&
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('preview');

export interface KernelStatus {
  running: boolean;
  pid: number | null;
  /** 启动前自动关闭的端口占用进程 pid。 */
  reclaimed?: number[];
}

export interface TrayNode {
  name: string;
  delay: number | null;
  selected: boolean;
}

export interface TrayProfile {
  id: string;
  name: string;
}

export interface TraySnapshot {
  running: boolean;
  sysProxy: boolean;
  tun: boolean;
  mode: string;
  node: string | null;
  group: string | null;
  up: number;
  down: number;
  showSpeed: boolean;
  nodes: TrayNode[];
  profiles: TrayProfile[];
  activeProfile: string | null;
}

export interface KernelVersionInfo {
  name: string;
  version: string;
  path: string;
  builtin: boolean;
  size: number;
}

export interface KernelInfo {
  running: boolean;
  version: string | null;
  pid: number | null;
  rssKb: number | null;
  binary: string | null;
  bundledVersion: string | null;
}

export interface SysProxyState {
  enabled: boolean;
  host: string;
  port: number;
}

/** 订阅拉取结果：原文 + 响应头里的元信息（名字 / 流量 / 更新间隔）。 */
export interface SubscriptionPayload {
  raw: string;
  profileTitle: string | null;
  contentDisposition: string | null;
  subscriptionUserinfo: string | null;
  profileUpdateInterval: string | null;
}

// 预览用的假数据：只服务界面调试，不进生产包
const PREVIEW_NODES = [
  { name: '🇯🇵 东京 01 · IPLC', type: 'Trojan', delay: 42 },
  { name: '🇯🇵 东京 02', type: 'Trojan', delay: 68 },
  { name: '🇭🇰 香港 01 · 中转', type: 'VLESS', delay: 36 },
  { name: '🇭🇰 香港 02', type: 'VLESS', delay: 55 },
  { name: '🇸🇬 新加坡 01', type: 'Hysteria2', delay: 96 },
  { name: '🇺🇸 洛杉矶 01', type: 'Shadowsocks', delay: 168 },
  { name: '🇺🇸 西雅图 01', type: 'Shadowsocks', delay: 212 },
  { name: '🇩🇪 法兰克福 01', type: 'Trojan', delay: 306 },
];

function previewProxiesJson(): string {
  const proxies: Record<string, unknown> = {};
  for (const n of PREVIEW_NODES) {
    proxies[n.name] = {
      type: n.type,
      history: [{ delay: n.delay, time: new Date().toISOString() }],
    };
  }
  proxies['🚀 节点选择'] = {
    type: 'Selector',
    now: PREVIEW_NODES[0].name,
    all: PREVIEW_NODES.map((n) => n.name),
  };
  proxies['♻️ 自动选择'] = {
    type: 'URLTest',
    now: PREVIEW_NODES[2].name,
    all: PREVIEW_NODES.slice(0, 4).map((n) => n.name),
  };
  proxies['🌍 国外媒体'] = {
    type: 'Selector',
    now: PREVIEW_NODES[1].name,
    all: PREVIEW_NODES.slice(0, 6).map((n) => n.name),
  };
  return JSON.stringify({ proxies });
}

let previewT0 = Date.now();
let previewTick = 0;

function previewMihomo(method: string, path: string): unknown {
  if (path.startsWith('/rules')) {
    return {
      rules: [
        { type: 'DOMAIN-KEYWORD', payload: 'stun', proxy: 'REJECT-DROP' },
        { type: 'DST-PORT', payload: '3478-3479', proxy: 'REJECT-DROP' },
        { type: 'AND', payload: '((NETWORK,UDP),(DST-PORT,443))', proxy: 'REJECT-DROP' },
        { type: 'DOMAIN-SUFFIX', payload: 'youtube.com', proxy: '🌍 国外媒体' },
        { type: 'DOMAIN-SUFFIX', payload: 'github.com', proxy: '🚀 节点选择' },
        { type: 'DOMAIN-KEYWORD', payload: 'google', proxy: '🚀 节点选择' },
        { type: 'GEOIP', payload: 'CN', proxy: 'DIRECT' },
        { type: 'DOMAIN-SUFFIX', payload: 'apple.com', proxy: 'DIRECT' },
        { type: 'MATCH', payload: '', proxy: '🚀 节点选择' },
      ],
    };
  }
  if (path.startsWith('/connections') && method === 'GET') {
    return {
      uploadTotal: 1_234_567,
      downloadTotal: 45_678_901,
      connections: [
        {
          id: 'preview-1',
          upload: 12_345,
          download: 4_567_890,
          start: new Date(Date.now() - 42_000).toISOString(),
          chains: ['🚀 节点选择', '🇯🇵 东京 01 · IPLC'],
          rule: 'DOMAIN-SUFFIX',
          rulePayload: 'youtube.com',
          metadata: { network: 'tcp', host: 'www.youtube.com', destinationPort: 443 },
        },
        {
          id: 'preview-2',
          upload: 3_456,
          download: 234_567,
          start: new Date(Date.now() - 12_000).toISOString(),
          chains: ['🚀 节点选择', '🇭🇰 香港 01 · 中转'],
          rule: 'DOMAIN-SUFFIX',
          rulePayload: 'github.com',
          metadata: { network: 'tcp', host: 'github.com', destinationPort: 443 },
        },
        {
          id: 'preview-3',
          upload: 890,
          download: 12_345,
          start: new Date(Date.now() - 5_000).toISOString(),
          chains: ['DIRECT'],
          rule: 'GEOIP',
          rulePayload: 'CN',
          metadata: { network: 'udp', host: '223.5.5.5', destinationPort: 53 },
        },
      ],
    };
  }
  if (path.startsWith('/connections')) {
    previewTick += 1;
    const elapsed = Math.max(1, (Date.now() - previewT0) / 1000);
    // 造一条有起伏的曲线，截图时能看出视觉层次
    const wave = 0.65 + 0.35 * Math.sin(previewTick / 2.2);
    return {
      uploadTotal: Math.round(elapsed * 180_000 + wave * 60_000),
      downloadTotal: Math.round(elapsed * 2_400_000 + wave * 900_000),
      connections: [],
    };
  }
  if (path.startsWith('/proxies') && method === 'GET' && path.includes('/delay')) {
    return { delay: 36 + Math.round(Math.random() * 40) };
  }
  if (path.startsWith('/proxies')) {
    return JSON.parse(previewProxiesJson());
  }
  return {};
}

function previewCall(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'mihomo_request': {
      const r = previewMihomo(
        String(args?.method ?? 'GET'),
        String(args?.path ?? '/')
      );
      return JSON.stringify(r);
    }
    case 'kernel_status':
      return { running: true, pid: 12345 };
    case 'start_kernel':
      return { running: true, pid: 12345 };
    case 'stop_kernel':
      return { running: false, pid: null };
    case 'get_system_proxy':
      return { enabled: true, host: '127.0.0.1', port: 7890 };
    case 'leak_check_ip':
      return { direct: '198.51.100.7', proxied: '203.0.113.42' };
    case 'leak_check_dns':
      return {
        kernel_alive: true,
        kernel_fake_ip: true,
        system_ips: ['198.18.0.23'],
        system_fake_ip: true,
      };
    case 'set_system_proxy':
      return { enabled: Boolean(args?.enable), host: '127.0.0.1', port: 7890 };
    case 'save_config':
      return '/Users/preview/Library/Application Support/PPClash/config.yaml';
    case 'load_app_state':
      return null;
    case 'list_kernel_versions':
      return [
        {
          name: '内置内核',
          version: 'v1.19.32',
          path: '/Users/preview/Library/Application Support/PPClash/bin/mihomo',
          builtin: true,
          size: 61_386_224,
        },
        {
          name: 'v1.19.31',
          version: '1.19.31',
          path: '/Users/preview/Library/Application Support/PPClash/kernels/v1.19.31/mihomo',
          builtin: false,
          size: 61_000_000,
        },
      ];
    case 'list_resource_files':
      return [
        { name: 'geosite.dat', size: 4_272_747, exists: true },
        { name: 'geoip.metadb', size: 8_423_041, exists: true },
        { name: 'geoip.dat', size: 16_587_403, exists: true },
        { name: 'country.mmdb', size: 401_173, exists: true },
        { name: 'ASN.mmdb', size: 8_974_108, exists: true },
      ];
    case 'kernel_info':
      return {
        running: true,
        version: 'v1.19.32',
        pid: 4321,
        rssKb: 96_000,
        binary: '/Users/preview/Library/Application Support/PPClash/bin/mihomo',
        bundledVersion: 'v1.19.32',
      };
    case 'read_kernel_log':
      return [
        'time="2026-11-02T20:00:01+08:00" level=info msg="Start initial configuration in progress"',
        'time="2026-11-02T20:00:01+08:00" level=info msg="Initial configuration complete, total time: 218ms"',
        'time="2026-11-02T20:00:02+08:00" level=info msg="[TCP] 127.0.0.1:52104 --> www.youtube.com:443 match DomainSuffix(youtube.com) using 🚀 节点选择[🇯🇵 东京 01 · IPLC]"',
        'time="2026-11-02T20:00:03+08:00" level=warning msg="[DNS] fallback is empty, using nameserver only"',
        'time="2026-11-02T20:00:05+08:00" level=info msg="[TCP] 127.0.0.1:52110 --> github.com:443 match DomainSuffix(github.com) using 🚀 节点选择[🇭🇰 香港 01 · 中转]"',
      ].join('\n');
    default:
      return null;
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    if (previewMode) return previewCall(cmd, args) as T;
    throw new Error(`浏览器预览模式不支持 ${cmd}，请用 npm run app 启动桌面端`);
  }
  return invoke<T>(cmd, args);
}

export const api = {
  fetchSubscription: (url: string, proxyPort?: number) =>
    call<SubscriptionPayload>('fetch_subscription', { url, proxyPort }),

  /** 读取本地 Clash/mihomo 配置文件（10MB 上限，仅 yaml/yml/json）。 */
  readSubscriptionFile: (path: string) => call<string>('read_subscription_file', { path }),

  saveConfig: (content: string, dataDir: string) =>
    call<string>('save_config', { content, dataDir }),

  startKernel: (
    configPath: string,
    dataDir: string,
    binaryPath: string | null,
    privileged: boolean,
    controllerPort: number
  ) =>
    call<KernelStatus>('start_kernel', {
      configPath,
      dataDir,
      binaryPath: binaryPath ?? null,
      privileged,
      controllerPort,
    }),

  stopKernel: () => call<KernelStatus>('stop_kernel'),

  /** 清理上次崩溃/强退留下的内核进程（含 TUN）。 */
  cleanupStaleKernel: () => call<void>('cleanup_stale_kernel'),

  kernelStatus: () => call<KernelStatus>('kernel_status'),

  /** 重新解压内置内核与 Geo 数据。 */
  reinstallResources: () => call<string>('reinstall_bundled_resources'),

  /** 本地可用内核版本：内置 + 已下载。 */
  listKernelVersions: () => call<KernelVersionInfo[]>('list_kernel_versions'),

  /** 内置 Geo 资源文件状态。 */
  listResourceFiles: () =>
    call<Array<{ name: string; size: number; exists: boolean }>>('list_resource_files'),

  /** 下载当前平台最新稳定版内核。 */
  downloadKernelVersion: (proxyUrl?: string, mirrorPrefix?: string) =>
    call<KernelVersionInfo>('download_kernel_version', { proxyUrl, mirrorPrefix }),

  /** 内核版本 / 内存 / 路径。 */
  kernelInfo: () => call<KernelInfo>('kernel_info'),

  /** 用内核 -t 校验生成配置。 */
  validateConfig: (configPath: string, dataDir: string) =>
    call<void>('validate_config', { configPath, dataDir }),

  /** 从 .app 包提取进程图标，返回 data URL。 */
  resolveProcessIcon: (processPath: string) =>
    call<string | null>('resolve_process_icon', { processPath }),

  /** 读取内核日志尾部若干行。 */
  readKernelLog: (lines = 400) => call<string>('read_kernel_log', { lines }),

  /** 备份当前 state.json 到数据目录 backups/。 */
  backupAppState: (dataDir: string) => call<string>('backup_app_state', { dataDir }),

  /** 已有备份列表（新的在前）。 */
  listBackups: (dataDir: string) =>
    call<Array<{ name: string; size: number; mtimeMs: number }>>('list_backups', { dataDir }),

  /** 从备份恢复 state.json（需要重新加载应用）。 */
  restoreBackup: (dataDir: string, name: string) =>
    call<void>('restore_backup', { dataDir, name }),

  setSystemProxy: (enable: boolean, host: string, port: number) =>
    call<SysProxyState>('set_system_proxy', { enable, host, port }),

  getSystemProxy: () => call<SysProxyState>('get_system_proxy'),

  /** 开机自启（macOS LaunchAgent）。 */
  setLaunchLogin: (enable: boolean) => call<void>('set_launch_login', { enable }),

  /** 关窗行为：true=最小化到托盘，false=直接退出。 */
  setCloseToTray: (enabled: boolean) => call<void>('set_close_to_tray', { enabled }),

  /** 在 Finder 打开数据目录。 */
  openDataDir: (dataDir: string) => call<void>('open_data_dir', { dataDir }),

  /** 落盘应用状态（订阅 / 活动订阅 / 策略 / 设置）。 */
  saveAppState: (content: string, dataDir: string) =>
    call<void>('save_app_state', { content, dataDir }),

  /** 读取应用状态。没有则返回 null。 */
  loadAppState: (dataDir: string) => call<string | null>('load_app_state', { dataDir }),

  /** 转发一次 mihomo API 请求。base / secret 可配，默认走本机控制端口。 */
  mihomo: async (
    method: string,
    path: string,
    body?: unknown,
    base?: string,
    secret?: string
  ): Promise<unknown> => {
    const raw = await call<string>('mihomo_request', {
      base: base ?? 'http://127.0.0.1:9090',
      secret: secret ?? '',
      method,
      path,
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  },

  /** 把前端状态（TUN / 系统代理 / 端口）推给托盘并重建托盘菜单。 */
  setTrayFlags: (
    tunEnabled: boolean,
    sysProxyEnabled: boolean,
    mixedPort: number,
    mode: string,
    showSpeed: boolean,
    hideDock: boolean
  ) =>
    call<void>('set_tray_flags', {
      tunEnabled,
      sysProxyEnabled,
      mixedPort,
      mode,
      showSpeed,
      hideDock,
    }),

  traySnapshot: () => call<TraySnapshot>('tray_snapshot'),

  trayAction: (action: string, value?: string) =>
    call<void>('tray_action', { action, value: value ?? null }),

  /** 泄漏自检：直连 vs 代理出口 IP。 */
  leakCheckIp: (mixedPort: number, tunEnabled = false) =>
    call<{ direct: string | null; proxied: string | null }>('leak_check_ip', {
      mixedPort,
      tunEnabled,
    }),

  /** 泄漏自检：DNS 接管状态（内核 DNS 端口 + 系统解析）。 */
  leakCheckDns: (domain: string, dnsPort = 1053) =>
    call<{
      kernel_alive: boolean;
      kernel_fake_ip: boolean;
      system_ips: string[];
      system_fake_ip: boolean;
    }>('leak_check_dns', { domain, dnsPort }),
};

/** 数据目录，跟内核工作目录一致。 */
export const DATA_DIR = 'PPClash';
