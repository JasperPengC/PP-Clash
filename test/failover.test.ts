import { describe, expect, it } from 'vitest';
import { FailoverGuard, FailoverCoordinator, CHECK_INTERVAL, SWITCH_COOLDOWN, type FailoverTarget } from '../src/core/failover';
import { routingPolicy } from '../src/core/routing-policy';

const failed = { google: false, github: false, openai: true };
it('主出口取 MATCH 目标，独立地区组不会因节点更多成为主路由', () => {
  expect(routingPolicy([
    { name: 'Region', type: 'url-test', proxies: ['A', 'B', 'C'] },
    { name: 'Main', type: 'select', proxies: ['Auto'] },
    { name: 'Auto', type: 'url-test', proxies: ['A'] },
  ], ['MATCH,Main'])).toEqual({ primary: 'Main', managed: ['Main', 'Auto'], roots: ['Main'] });
});
describe('保守故障切换判定', () => {
  it('同两个服务连续三轮失败才允许切换', () => {
    const g = new FailoverGuard();
    expect(g.observe('A', failed, 0)).toBe(false);
    expect(g.observe('A', failed, CHECK_INTERVAL)).toBe(false);
    expect(g.observe('A', failed, CHECK_INTERVAL * 2)).toBe(true);
  });
  it('单站失败、未知、不同站轮流失败不会累计成出口故障', () => {
    const g = new FailoverGuard();
    const rounds = [
      { google: false, github: false, openai: true },
      { google: false, github: true, openai: false },
      { google: true, github: false, openai: false },
      { google: null, github: false, openai: true },
    ];
    rounds.forEach((r, i) => expect(g.observe('A', r, i * CHECK_INTERVAL)).toBe(false));
  });
  it('换节点、过密调用和睡眠后的旧失败均不能触发切换', () => {
    const g = new FailoverGuard();
    g.observe('A', failed, 0);
    g.observe('A', failed, CHECK_INTERVAL);
    expect(g.observe('A', failed, CHECK_INTERVAL + 1)).toBe(false);
    expect(g.observe('B', failed, CHECK_INTERVAL * 2)).toBe(false);
    expect(g.observe('B', failed, CHECK_INTERVAL * 8)).toBe(false);
  });
  it('切换后冷却十分钟，冷却内不累积失败', () => {
    const g = new FailoverGuard();
    g.switched(0);
    for (let t = 0; t < SWITCH_COOLDOWN; t += CHECK_INTERVAL) expect(g.observe('A', failed, t)).toBe(false);
    expect(g.observe('A', failed, SWITCH_COOLDOWN)).toBe(false);
    expect(g.observe('A', failed, SWITCH_COOLDOWN + CHECK_INTERVAL)).toBe(false);
    expect(g.observe('A', failed, SWITCH_COOLDOWN + CHECK_INTERVAL * 2)).toBe(true);
  });
});

describe('切换协调', () => {
  it('候选探测期间休眠，唤醒后的旧成功不能触发切换', async () => {
    let now = 0; let selected = 'A'; let finish!: (v: Record<string, boolean>) => void;
    const c = new FailoverCoordinator({ target: () => ({ key: selected, node: selected, candidates: ['B'] }), now: () => now,
      probe: node => node === 'A' ? Promise.resolve(failed) : new Promise(r => { finish = r; }),
      switchTo: async node => { selected = node; } });
    await c.check(); now += CHECK_INTERVAL; await c.check(); now += CHECK_INTERVAL;
    const pending = c.check(); await Promise.resolve();
    now += 3_600_000; finish({ google: true, github: true }); await pending;
    expect(selected).toBe('A');
    await c.check(); expect(selected).toBe('A');
  });
  it('候选预算用完后下一轮继续检查后面的备用节点', async () => {
    let now = 0; let node = 'A';
    const c = new FailoverCoordinator({ target: () => ({ key: node, node, candidates: ['bad1', 'bad2', 'bad3', 'good'] }), now: () => now,
      probe: async n => n === 'good' ? { google: true, github: true } : failed,
      switchTo: async n => { node = n; } });
    for (let i = 0; i < 6; i++) { await c.check(); now += CHECK_INTERVAL; }
    expect(node).toBe('good');
  });
  it('检测期间用户改变出口后丢弃结果，候选检测不修改当前节点', async () => {
    let target: FailoverTarget = { key: 'route-A', node: 'A', candidates: ['B'] };
    let finish!: (v: typeof failed) => void;
    let switches = 0;
    const c = new FailoverCoordinator({ target: () => target, now: () => 0,
      probe: () => new Promise(r => { finish = r; }), switchTo: async () => { switches++; } });
    const p = c.check();
    await c.check(); // 正在检测时不会开启第二轮
    target = { ...target, key: 'route-C', node: 'C' };
    finish(failed);
    await p;
    expect(switches).toBe(0);
  });
  it('三轮故障后只切到已验证的候选，且进入冷却', async () => {
    let now = 0;
    let node = 'A';
    const visited: string[] = [];
    const c = new FailoverCoordinator({
      target: () => ({ key: node, node, candidates: ['bad', 'B'] }), now: () => now,
      probe: async n => { visited.push(n); return n === 'B' ? { google: true, github: true, openai: true } : failed; },
      switchTo: async n => { node = n; },
    });
    await c.check(); now += CHECK_INTERVAL;
    await c.check(); now += CHECK_INTERVAL;
    await c.check();
    expect(node).toBe('B');
    expect(visited).toEqual(['A', 'A', 'A', 'bad', 'B']);
    now += CHECK_INTERVAL;
    await c.check();
    expect(node).toBe('B');
  });
});
