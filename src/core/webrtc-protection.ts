import { api } from './api';

export interface WebRtcProtection {
  verified: boolean;
  status: 'ok' | 'warn' | 'info';
  text: string;
}

const normalizeType = (value: unknown) => typeof value === 'string' ? value.replace(/[-_]/g, '').toLowerCase() : '';
const blocked = (value: unknown) => value === 'REJECT' || value === 'REJECT-DROP';
type Rule = { type?: unknown; payload?: unknown; proxy?: unknown };
const guards = [
  ['domainkeyword', 'stun'], ['dstport', '3478-3479'], ['dstport', '5349-5350'],
  ['dstport', '19302-19309'], ['domainsuffix', 'turn.twilio.com'],
];
const result = (status: WebRtcProtection['status'], text: string): WebRtcProtection => ({ status, text, verified: status === 'ok' });

/** 只核验既有 STUN 测试目标，不模拟 DNS/IP/进程规则；遇到未知前置规则必须停止推断。 */
function matchesStunTarget(rule: Rule): boolean | undefined {
  const type = normalizeType(rule.type);
  const payload = typeof rule.payload === 'string' ? rule.payload.toLowerCase() : '';
  const host = 'stun.l.google.com';
  if (type === 'match') return true;
  if (!payload) return undefined;
  if (type === 'domain') return host === payload;
  if (type === 'domainsuffix') return host === payload || host.endsWith(`.${payload}`);
  if (type === 'domainkeyword') return host.includes(payload);
  if (type === 'network') return payload === 'udp' ? true : payload === 'tcp' ? false : undefined;
  if (type === 'dstport') {
    if (!/^\d+(?:-\d+)?$/.test(payload)) return undefined;
    const [from, to = from] = payload.split('-').map(Number);
    if (from < 1 || to > 65535 || from > to) return undefined;
    return from <= 19302 && 19302 <= to;
  }
  return undefined;
}

/** 输入来自运行内核 /configs、/rules；不根据前端开关推断已经生效。 */
export function assessWebRtcProtection(config: unknown, response: unknown): WebRtcProtection {
  if (!config || typeof config !== 'object') return result('info', '无法读取运行配置，防护未核验');
  const { mode, tun } = config as { mode?: unknown; tun?: Record<string, unknown> };
  if (typeof mode !== 'string') return result('info', '运行模式未知，防护未核验');
  if (mode.toLowerCase() !== 'rule') return result('warn', '当前不是规则模式，STUN 阻断规则不生效');
  if (tun?.enable !== true || tun?.['auto-route'] !== true)
    return result('warn', 'TUN 自动接管未启用，系统代理不能接管 WebRTC UDP');
  if (tun['strict-route'] !== true) return result('warn', 'TUN 严格路由未启用，无法确认 UDP 接管范围');
  const rules = response && typeof response === 'object' ? (response as { rules?: unknown }).rules : null;
  if (!Array.isArray(rules) || !rules.length || rules.some(r => !r || typeof r !== 'object'))
    return result('info', '无法读取运行规则，防护未核验');
  if (!guards.every(([type, payload]) => rules.some(r => normalizeType(r.type) === type && r.payload === payload && blocked(r.proxy))))
    return result('warn', '运行规则缺少 STUN 防护项，检查安全设置是否已应用');
  for (const rule of rules) {
    const matches = matchesStunTarget(rule);
    if (matches === undefined) return result('info', '前置规则需要动态匹配，STUN 阻断优先级未核验');
    if (matches) return blocked(rule.proxy)
      ? result('ok', 'STUN 测试目标阻断规则已核验（TUN）')
      : result('warn', 'STUN 测试目标被前置规则放行，阻断未生效');
  }
  return result('warn', 'STUN 测试目标未匹配阻断规则');
}

export async function checkWebRtcProtection(): Promise<WebRtcProtection> {
  try {
    const [config, rules] = await Promise.all([api.mihomo('GET', '/configs'), api.mihomo('GET', '/rules')]);
    return assessWebRtcProtection(config, rules);
  } catch {
    // 控制器错误可能包含地址/认证信息，不直接回显。
    return result('info', '运行内核暂不可读，防护未核验');
  }
}
