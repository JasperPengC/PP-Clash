import { describe, expect, it } from 'vitest';
import { generateConfig, DEFAULT_RUNTIME } from '../src/core/generator';
import { DEFAULT_POLICY } from '../src/core/security';
import { DEFAULT_LATENCY_URL, GITHUB_LATENCY_URL, groupLatencyTarget, latencyKey, parseTargetLatencies, readGroupLatency } from '../src/core/latency';

const raw = `proxies:
  - {name: A, type: ss, server: example.test, port: 443, cipher: aes-256-gcm, password: example}
proxy-groups:
  - {name: 常规, type: select, proxies: [A]}
  - {name: 开发, type: url-test, proxies: [A], url: https://www.gstatic.com/generate_204, expected-status: 204, interval: 600}
rules: ["MATCH,常规"]
`;

describe('GitHub 分组测速目标', () => {
  it('生成固定组和订阅复用的中文开发组使用独立 HTTPS 目标，普通分组不变', () => {
    expect(groupLatencyTarget('GitHub 固定出口')).toBe(GITHUB_LATENCY_URL);
    expect(groupLatencyTarget('开发')).toBe(GITHUB_LATENCY_URL);
    expect(groupLatencyTarget('GitHub')).toBe(GITHUB_LATENCY_URL);
    expect(groupLatencyTarget('常规')).toBe(DEFAULT_LATENCY_URL);
    const target = new URL(GITHUB_LATENCY_URL);
    expect(target.protocol).toBe('https:'); expect(target.hostname).toBe('github.com');
    expect(target.pathname).toBe('/robots.txt');
  });

  it('分组测速策略不再改写订阅里的自动组配置', async () => {
    const automatic = JSON.parse((await generateConfig(raw, DEFAULT_POLICY, { ...DEFAULT_RUNTIME, stableRouting: false })).config);
    expect(automatic['proxy-groups'].find((g: any) => g.name === '开发')).toMatchObject({ type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 600 });
    const stable = JSON.parse((await generateConfig(raw, DEFAULT_POLICY, { ...DEFAULT_RUNTIME, stableRouting: true })).config);
    const group = stable['proxy-groups'].find((g: any) => g.name === '开发');
    expect(group).toMatchObject({ type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 600 });
    expect(stable['proxy-groups'].find((g: any) => g.name === '常规').url).toBeUndefined();
  });

  it('旧固定出口参数不会再生成额外代理组', async () => {
    const withoutDev = raw.replace(/  - \{name: 开发[^\n]*\n/, '');
    const config = JSON.parse((await generateConfig(withoutDev, DEFAULT_POLICY, { ...DEFAULT_RUNTIME,
      stableEgress: { enabled: true, node: 'A', domains: ['github.com'] }, stableRouting: true } as any)).config);
    expect(config['proxy-groups'].map((g: any) => g.name)).toEqual(['常规']);
  });

  it('覆写中的 GitHub 命名组继续服从用户配置', async () => {
    const config = JSON.parse((await generateConfig(raw, DEFAULT_POLICY, DEFAULT_RUNTIME, [{ mode: 'yaml', text: `proxy-groups:
  - {name: 开发, type: fallback, proxies: [A], url: https://other.test, interval: 900}
  - {name: 视频, type: url-test, proxies: [A], url: https://video.test, interval: 1200}
` }])).config);
    expect(config['proxy-groups'][0]).toMatchObject({ url: 'https://other.test', interval: 900 });
    expect(config['proxy-groups'][1]).toMatchObject({ url: 'https://video.test', interval: 1200 });
  });

  it('同节点的分组和目标结果分别存储，GitHub 未测和失败不使用通用历史', () => {
    const cache = { [latencyKey('常规', DEFAULT_LATENCY_URL, 'A')]: 22 };
    expect(readGroupLatency(cache, '开发', 'A', { [DEFAULT_LATENCY_URL]: 22 })).toBeUndefined();
    cache[latencyKey('开发', GITHUB_LATENCY_URL, 'A')] = 91;
    expect(readGroupLatency(cache, '开发', 'A', { [DEFAULT_LATENCY_URL]: 22 })).toBe(91);
    expect(readGroupLatency(cache, '常规', 'A', { [GITHUB_LATENCY_URL]: 91 })).toBe(22);
    const failed = { ...cache, [latencyKey('开发', GITHUB_LATENCY_URL, 'A')]: null };
    expect(readGroupLatency(failed, '开发', 'A', { [GITHUB_LATENCY_URL]: 22 })).toBeNull();
    expect(readGroupLatency(cache, '另一开发组', 'A', { [DEFAULT_LATENCY_URL]: 22 })).toBeUndefined();
  });

  it('只从明确 URL 的 extra 历史读取自动测速，未标目标的 history 不冒充任一目标', () => {
    const reported = parseTargetLatencies({ history: [{ delay: 999 }], extra: {
      [DEFAULT_LATENCY_URL]: { Alive: true, History: [{ delay: 32 }, { delay: 22 }] },
      [GITHUB_LATENCY_URL]: { Alive: true, History: [{ delay: 91 }] },
    } });
    expect(readGroupLatency({}, '开发', 'A', reported)).toBe(91);
    expect(readGroupLatency({}, '常规', 'A', reported)).toBe(22);
    expect(parseTargetLatencies({ history: [{ delay: 999 }] })).toEqual({});
    expect(parseTargetLatencies({ extra: { [GITHUB_LATENCY_URL]: { Alive: false, History: [{ delay: 0 }] } } })).toEqual({ [GITHUB_LATENCY_URL]: null });
  });
});
