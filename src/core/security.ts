/**
 * 安全策略。
 *
 * 这是 PPClash 的核心取舍：**订阅只负责提供节点，安全配置一律由应用注入。**
 *
 * 为什么不让用户自己写 YAML？因为最常见的泄漏恰恰来自订阅自带的 DNS 段：
 *   · nameserver 里混进 223.5.5.5 这类明文国内 DNS
 *   · fallback 里塞着国内解析器，而 mihomo 的 fallback 与 nameserver 是并发查询的，
 *     于是每个境外域名都会被明文问一遍
 *   · 关掉 respect-rules，DNS 查询不走代理，境外域名在本地明文解析
 *   · IPv6 开着，TUN 只接管了 IPv4，流量从 v6 绕出去
 *
 * 这些都不是用户能靠「看一眼配置」发现的，所以它们不该是配置项，而应该是默认行为。
 */

export interface SecurityPolicy {
  /** DNS 防泄漏：域名一律走加密 DNS，且 DNS 查询本身跟随代理规则。 */
  dnsLeakProtection: boolean;
  /** Fake-IP：本地不做真实解析，减少解析时序和缓存带来的泄漏面。 */
  fakeIp: boolean;
  /** IPv6：默认关闭。开启后本地 v6 地址可能绕过只接管 v4 的 TUN 直连出去。 */
  ipv6: boolean;
  /** STUN / WebRTC 阻断：拦掉打洞用的 UDP 端口，防止真实 IP 经 P2P 暴露。 */
  blockWebRtc: boolean;
  /** TUN 严格路由：把不走系统代理的进程也纳入接管。 */
  tunStrictRoute: boolean;
  /** 阻断 QUIC：UDP/443 的 QUIC 会绕开部分 HTTP 代理链路。 */
  blockQuic: boolean;
}

/** 默认策略：能开的防护全开。唯一保守的是 QUIC 阻断（会影响部分视频站）。 */
export const DEFAULT_POLICY: SecurityPolicy = {
  dnsLeakProtection: true,
  fakeIp: true,
  ipv6: false,
  blockWebRtc: true,
  tunStrictRoute: true,
  blockQuic: false,
};

export const POLICY_META: Record<
  keyof SecurityPolicy,
  { label: string; desc: string; risk: string }
> = {
  dnsLeakProtection: {
    label: 'DNS 防泄漏',
    desc: '加密解析，解析请求跟随规则',
    risk: '关闭后 DNS 在本地明文解析',
  },
  fakeIp: {
    label: 'Fake-IP 模式',
    desc: '连接时由代理解析域名',
    risk: '关闭后每次访问都需真实 DNS 查询',
  },
  blockWebRtc: {
    label: 'WebRTC / STUN 阻断',
    desc: '拦截 STUN 打洞',
    risk: '关闭后可能暴露真实 IP',
  },
  ipv6: {
    label: 'IPv6 隔离',
    desc: '关闭 IPv6',
    risk: '开启后部分流量可能绕过 TUN',
  },
  tunStrictRoute: {
    label: 'TUN 严格路由',
    desc: '接管不走代理的进程',
    risk: '关闭后部分应用会绕过代理',
  },
  blockQuic: {
    label: '阻断 QUIC',
    desc: '拦截 UDP/443',
    risk: '关闭后部分站点会走 QUIC',
  },
};

/** 顶层配置：这些字段订阅里就算写了也会被覆盖。 */
export function buildTopLevel(policy: SecurityPolicy) {
  return {
    ipv6: policy.ipv6,
    'log-level': 'warning',
    'unified-delay': true,
    'tcp-concurrent': false,
    // 不让内核自己联网更新 Geo 数据：国内网络下会长时间卡住启动，
    // 数据由客户端在启动前准备好（见 Rust 侧 ensure_geodata）
    'geo-auto-update': false,
    // 让「当前选中」和 fake-ip 映射在重启后保留，换机场不用重选节点
    profile: {
      'store-selected': true,
      'store-fake-ip': true,
    },
  };
}

export function buildDns(policy: SecurityPolicy, dnsPort = 1053) {
  if (!policy.dnsLeakProtection) {
    // 关掉防泄漏时仍然把 DNS 交给内核处理，只是不做加密和分流约束，
    // 至少不会出现「DNS 没人管」的更糟状态。
    return {
      enable: true,
      ipv6: policy.ipv6,
      'enhanced-mode': 'normal',
      nameserver: ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
    };
  }

  const outbound = ['tls://1.1.1.1:853', 'https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'];

  return {
    enable: true,
    ipv6: policy.ipv6,
    'enhanced-mode': policy.fakeIp ? 'fake-ip' : 'redir-host',
    ...(policy.fakeIp ? { 'fake-ip-range': '198.18.0.1/16' } : {}),
    listen: `127.0.0.1:${dnsPort}`,
    // DoH 走 QUIC 会经 UDP 通道抖动，且部分网络直接掐 QUIC
    'prefer-h3': false,
    // 关键：DNS 查询本身跟随规则走，境外解析器才会经代理发出
    'respect-rules': true,
    // 仅用于解析下面那两个【国内】引导域名，不构成泄漏
    'default-nameserver': ['223.5.5.5'],
    // 节点域名必须用国内解析，否则解析节点自己会死循环
    'proxy-server-nameserver': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
    // 只放 IP 形式的境外加密解析器。这里绝不能出现明文国内 DNS：
    // mihomo 对 nameserver 是逐项并发查询的，任何明文项都会为每个域名发一次明文查询。
    nameserver: outbound,
    // 必须显式写空数组。不写某键 ≠ 清空它，订阅的值会原样保留。
    fallback: [],
    // nameserver-policy 首个命中即返回，所以顺序就是优先级。
    // !cn 必须排在 cn 前面：geosite:cn 会把部分境外域名误判成国内，拿到污染 IP。
    'nameserver-policy': {
      'geosite:geolocation-!cn': outbound,
      'geosite:cn,private': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
    },
    'fake-ip-filter': [
      '+.lan',
      '+.local',
      '+.example.com',
      '+.invalid',
      '+.test',
      'time.*.com',
      'ntp.*.com',
      '+.pool.ntp.org',
      'localhost.ptlogin2.qq.com',
    ],
  };
}

export function buildTun(policy: SecurityPolicy, enable: boolean) {
  return {
    enable,
    // darwin 上 gvisor 会让 TUN 起不来（missing interface address），必须用 mixed
    stack: 'mixed',
    'auto-route': true,
    'auto-detect-interface': true,
    'strict-route': policy.tunStrictRoute,
    'dns-hijack': ['any:53'],
    mtu: 1500,
  };
}

export function buildSniffer() {
  return {
    enable: true,
    'parse-pure-ip': true,
    'force-dns-mapping': true,
    'override-destination': false,
    sniff: {
      HTTP: { ports: [80, 443], 'override-destination': false },
      TLS: { ports: [443] },
      QUIC: { ports: [443] },
    },
    'skip-domain': ['+.push.apple.com'],
  };
}

/** 防泄漏规则。会被插到订阅规则的最前面，先于一切业务规则生效。 */
export function buildGuardRules(policy: SecurityPolicy): string[] {
  const rules: string[] = [];

  if (policy.blockWebRtc) {
    rules.push(
      'DOMAIN-KEYWORD,stun,REJECT-DROP',
      'DST-PORT,3478-3479,REJECT-DROP',
      'DST-PORT,5349-5350,REJECT-DROP',
      'DST-PORT,19302-19309,REJECT-DROP',
      'DOMAIN-SUFFIX,turn.twilio.com,REJECT-DROP'
    );
  }

  if (policy.blockQuic) {
    // 只掐 UDP/443。写成 DST-PORT,443 会把所有 HTTPS 一起断掉。
    rules.push('AND,((NETWORK,UDP),(DST-PORT,443)),REJECT-DROP');
  }

  return rules;
}
