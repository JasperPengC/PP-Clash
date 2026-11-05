import { previewMode } from '../core/api';
import { DEFAULT_POLICY } from '../core/security';
import { DEFAULT_SETTINGS, useApp } from '../store/app';

/**
 * 仅开发环境：浏览器里预览「连接态 / 订阅预览态」。
 *
 *   /?preview=connected  已连接：有分组、有流量曲线
 *   /?preview=ready      已导入订阅但内核未连接：节点页展示订阅原文解析结果
 */

const NODES = [
  { name: '🇯🇵 东京 01', type: 'Trojan', delay: 42 },
  { name: '🇯🇵 东京 02', type: 'Trojan', delay: 68 },
  { name: '🇭🇰 香港 01', type: 'VLESS', delay: 36 },
  { name: '🇭🇰 香港 02', type: 'VLESS', delay: 55 },
  { name: '🇸🇬 新加坡 01', type: 'Hysteria2', delay: 96 },
  { name: '🇺🇸 洛杉矶 01', type: 'Shadowsocks', delay: 168 },
  { name: '🇺🇸 西雅图 01', type: 'Shadowsocks', delay: 212 },
  { name: '🇩🇪 法兰克福 01', type: 'Trojan', delay: 306 },
];

/** 一份接近真实机场结构的订阅原文：含分组、含「剩余流量」这类信息节点。 */
const PREVIEW_RAW = `mixed-port: 7890
mode: rule
proxies:
  - {name: "🇯🇵 东京 01", type: trojan, server: jp1.example.com, port: 443, password: p1, sni: jp1.example.com, skip-cert-verify: true}
  - {name: "🇯🇵 东京 02", type: trojan, server: jp2.example.com, port: 443, password: p2, sni: jp2.example.com, skip-cert-verify: true}
  - {name: "🇭🇰 香港 01", type: vless, server: hk1.example.com, port: 443, uuid: u1, network: ws, tls: true}
  - {name: "🇭🇰 香港 02", type: vless, server: hk2.example.com, port: 443, uuid: u2, network: ws, tls: true}
  - {name: "🇸🇬 新加坡 01", type: hysteria2, server: sg1.example.com, port: 443, password: p3}
  - {name: "🇺🇸 洛杉矶 01", type: ss, server: us1.example.com, port: 8388, cipher: aes-256-gcm, password: p4}
  - {name: "🇺🇸 西雅图 01", type: ss, server: us2.example.com, port: 8388, cipher: aes-256-gcm, password: p5}
  - {name: "🇩🇪 法兰克福 01", type: trojan, server: de1.example.com, port: 443, password: p6, sni: de1.example.com, skip-cert-verify: true}
  - {name: "剩余流量：1.91 TB", type: hysteria2, server: info.example.com, port: 443, password: info1}
  - {name: "套餐到期：2027-03-16", type: hysteria2, server: info.example.com, port: 443, password: info2}
proxy-groups:
  - {name: "🚀 节点选择", type: select, proxies: ["♻️ 自动选择", "🇯🇵 东京 01", "🇯🇵 东京 02", "🇭🇰 香港 01", "🇭🇰 香港 02", "🇸🇬 新加坡 01", "🇺🇸 洛杉矶 01", "🇺🇸 西雅图 01", "🇩🇪 法兰克福 01"]}
  - {name: "♻️ 自动选择", type: url-test, url: "https://www.gstatic.com/generate_204", interval: 300, proxies: ["🇯🇵 东京 01", "🇭🇰 香港 01", "🇸🇬 新加坡 01"]}
  - {name: "🌍 国外媒体", type: select, proxies: ["🚀 节点选择", "🇯🇵 东京 02", "🇭🇰 香港 02"]}
`;

const PREVIEW_PROFILE = {
  id: 'preview-profile',
  name: 'Example Air',
  url: 'https://example.com/subscribe?token=demo',
  raw: PREVIEW_RAW,
  updatedAt: Date.now() - 1000 * 60 * 42,
  userinfo: {
    upload: 8_921_017_230,
    download: 36_608_187_967,
    total: 2_147_483_648_000,
    expire: 1_805_204_537,
  },
  updateIntervalHours: 24,
};

const AUDIT = [
  {
    code: 'PLAINTEXT_DNS',
    severity: 'high' as const,
    message:
      'DNS 解析器里有 2 个明文地址（223.5.5.5、114.114.114.114），境外域名会被本地明文解析',
  },
  {
    code: 'FALLBACK_SET',
    severity: 'high' as const,
    message:
      'fallback 里还有 3 个解析器，它们会和 nameserver 并发查询，等于每个域名都多问一遍',
  },
  {
    code: 'NO_RESPECT_RULES',
    severity: 'high' as const,
    message: '未开启 respect-rules，DNS 查询不会跟随代理规则',
  },
  {
    code: 'IPV6_ENABLED',
    severity: 'medium' as const,
    message: '开启了 IPv6，本地 v6 地址可能绕过只接管 v4 的 TUN',
  },
];

export function applyPreviewIfRequested() {
  if (!previewMode) return;
  const mode = new URLSearchParams(window.location.search).get('preview');
  const connected = mode !== 'ready';
  if (new URLSearchParams(window.location.search).get('theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
  }

  useApp.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      advancedMode: true,
      customRules: [
        { id: 'r1', type: 'DOMAIN-SUFFIX', payload: 'openai.com', target: '__CURRENT__', enabled: true },
        { id: 'r2', type: 'MATCH', payload: '', target: '__CURRENT__', enabled: false },
      ],
      overrides: [
        {
          id: 'preview-dns',
          name: 'DNS 覆写',
          mode: 'yaml',
          enabled: true,
          text: 'dns:\n  nameserver:\n    - https://dns.google/dns-query\n',
        },
        {
          id: 'preview-log',
          name: '调试日志',
          mode: 'js',
          enabled: false,
          text: 'config["log-level"] = "debug";\nreturn config;\n',
        },
      ],
    },
    policy: { ...DEFAULT_POLICY, blockQuic: true },
    profiles: [PREVIEW_PROFILE],
    activeId: PREVIEW_PROFILE.id,
    stats: { proxyCount: 8, groupCount: 3, ruleCount: 245, guardRuleCount: 5 },
    audit: AUDIT,
    configPath: '/Users/preview/Library/Application Support/PPClash/config.yaml',
    dataDir: '/Users/preview/Library/Application Support/PPClash',
    ...(connected
      ? {
          kernelPhase: 'running' as const,
          connectedAt: Date.now() - 1000 * 60 * 42,
          sysProxyEnabled: false,
          tunEnabled: true,
          groups: [
            {
              name: '🚀 节点选择',
              type: 'Selector',
              now: NODES[0].name,
              nodes: NODES,
            },
            {
              name: '♻️ 自动选择',
              type: 'URLTest',
              now: NODES[2].name,
              nodes: NODES.slice(0, 4),
            },
            {
              name: '🌍 国外媒体',
              type: 'Selector',
              now: NODES[1].name,
              nodes: NODES.slice(0, 6),
            },
          ],
        }
      : {
          kernelPhase: 'stopped' as const,
          sysProxyEnabled: false,
          tunEnabled: false,
          groups: [],
        }),
  });
}
