import { isStableEgressName } from './routing-policy';

// 与后台 Google 健康检查共用目标，直接复用已有历史，避免重复发起测速。
export const DEFAULT_LATENCY_URL = 'https://www.google.com/generate_204';
/** GitHub 主站的公开小文本资源，不使用 API、登录接口或账户凭据。 */
export const GITHUB_LATENCY_URL = 'https://github.com/robots.txt';
export type TargetLatencies = Record<string, number | null>;
export type GroupLatencies = Record<string, number | null>;

export function groupLatencyTarget(group: string): string {
  return isStableEgressName(group) ? GITHUB_LATENCY_URL : DEFAULT_LATENCY_URL;
}

export function latencyTestQuery(target: string): string {
  const params = new URLSearchParams({ url: target, timeout: '5000' });
  if (target === GITHUB_LATENCY_URL) params.set('expected', '200');
  return params.toString();
}

export function latencyKey(group: string, target: string, node: string): string {
  return JSON.stringify([group, target, node]);
}

export function normalizeLatency(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** 概览页统一使用的延迟状态阈值：与桌面端连接主卡保持一致。 */
export function latencyTone(value: number | null | undefined): 'good' | 'warn' | 'bad' | 'idle' {
  const delay = normalizeLatency(value);
  if (delay === null) return 'idle';
  if (delay < 120) return 'good';
  if (delay < 260) return 'warn';
  return 'bad';
}

/** mihomo adapter/adapter.go ExtraDelayHistories + constant/adapters.go ProxyState。
 * extra 的键就是测速 URL；通用 history 没有来源信息，不能用于目标专属延迟。
 */
export function parseTargetLatencies(raw: unknown): TargetLatencies {
  const extra = raw && typeof raw === 'object' ? (raw as { extra?: unknown }).extra : null;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {};
  const result: TargetLatencies = {};
  for (const [target, value] of Object.entries(extra)) {
    if (!value || typeof value !== 'object') continue;
    const state = value as { History?: unknown; history?: unknown; Alive?: boolean; alive?: boolean };
    const history = state.History ?? state.history;
    if (!Array.isArray(history) || history.length === 0) continue;
    result[target] = state.Alive === false || state.alive === false ? null : normalizeLatency(history[history.length - 1]?.delay);
  }
  return result;
}

/** undefined 为尚未测量，null 为已测失败；失败不得回落到另一目标的成功历史。 */
export function readGroupLatency(cache: GroupLatencies, group: string, node: string, reported: TargetLatencies = {}): number | null | undefined {
  const target = groupLatencyTarget(group);
  const key = latencyKey(group, target, node);
  return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : reported[target];
}
