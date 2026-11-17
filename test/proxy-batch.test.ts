// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLatencyBatchRunner, type LatencyBatchUpdate } from '../src/core/latency-batch';
import { useApp } from '../src/store/app';
import { api } from '../src/core/api';
import { DEFAULT_LATENCY_URL, GITHUB_LATENCY_URL } from '../src/core/latency';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});
const initial = useApp.getInitialState();
const target = (node: string, url = DEFAULT_LATENCY_URL, group = '常规') => ({ node, target: url, group });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); useApp.setState({ ...initial, activeId: 'fixture', connectedAt: 1, kernelPhase: 'running',
  groups: ['常规', '开发'].map(name => ({ name, type: 'Selector', now: 'A', nodes: [{ name: 'A', type: 'Shadowsocks', delay: null }] })) }); });
afterEach(() => vi.useRealTimers());

it('同节点同目标只测一次，GitHub 独立；结果按200ms合并，结束立即flush', async () => {
  const runner = createLatencyBatchRunner();
  const pending: Array<(delay: number) => void> = [];
  const measure = vi.fn(() => new Promise<number>(resolve => pending.push(resolve)));
  const updates: LatencyBatchUpdate[] = [];
  const batch = runner.start([target('A'), target('A', DEFAULT_LATENCY_URL, '另组'), target('A', GITHUB_LATENCY_URL, '开发'), target('B'), target('C')],
    { measure, onUpdate: update => updates.push(update) });
  expect(measure.mock.calls).toHaveLength(3);
  expect(updates[0].progress.total).toBe(4);
  pending[0](21); pending[1](82); await tick();
  expect(measure.mock.calls).toHaveLength(4);
  expect(updates.filter(update => update.results.length)).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(199);
  expect(updates.filter(update => update.results.length)).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(updates.at(-1)!.results).toEqual([
    { ...target('A'), delay: 21 }, { ...target('A', DEFAULT_LATENCY_URL, '另组'), delay: 21 },
    { ...target('A', GITHUB_LATENCY_URL, '开发'), delay: 82 },
  ]);
  expect(updates.at(-1)!.progress.completed).toBe(2);
  pending[2](31); pending[3](41); await batch.done;
  expect(updates.at(-1)!.progress).toMatchObject({ completed: 4, total: 4, status: 'completed' });
  expect(updates.at(-1)!.results.map(result => result.node)).toEqual(['B', 'C']);
});

it('取消立即停止队列，新旧批次共用3个槽，迟到结果不发布', async () => {
  const runner = createLatencyBatchRunner();
  const pending: Array<(delay: number) => void> = [];
  const started: string[] = [];
  const updates: LatencyBatchUpdate[] = [];
  const measure = (item: { node: string }) => new Promise<number>(resolve => { started.push(item.node); pending.push(resolve); });
  const old = runner.start(['A', 'B', 'C', 'D'].map(node => target(node)), { measure, onUpdate: update => updates.push(update) });
  old.cancel();
  const next = runner.start(['E', 'F', 'G', 'H'].map(node => target(node)), { measure, onUpdate: update => updates.push(update) });
  expect(started).toEqual(['A', 'B', 'C']);
  pending.splice(0).forEach(resolve => resolve(999)); await tick();
  expect(started).toEqual(['A', 'B', 'C', 'E', 'F', 'G']);
  pending.splice(0).forEach(resolve => resolve(21)); await tick();
  expect(started.at(-1)).toBe('H'); pending.splice(0).forEach(resolve => resolve(21));
  await next.done;
  expect(updates.flatMap(update => update.results).some(result => result.delay === 999)).toBe(false);
  expect(updates.find(update => update.progress.status === 'cancelled')?.progress).toMatchObject({ completed: 0, total: 4 });
});

it('失效时丢弃缓冲及在途回包，不再派发剩余项', async () => {
  const runner = createLatencyBatchRunner(); let current = true;
  const pending: Array<(delay: number) => void> = [];
  const updates: LatencyBatchUpdate[] = [];
  const batch = runner.start(['A', 'B', 'C', 'D', 'E'].map(node => target(node)), {
    measure: () => new Promise(resolve => pending.push(resolve)), isCurrent: () => current,
    onUpdate: update => updates.push(update),
  });
  pending.shift()!(21); await tick(); expect(pending).toHaveLength(3);
  current = false;
  pending.splice(0).forEach(resolve => resolve(21)); await batch.done;
  await vi.advanceTimersByTimeAsync(500);
  expect(updates.flatMap(update => update.results)).toEqual([]);
  expect(updates.at(-1)?.progress.status).toBe('cancelled');
});

it('请求失败计入完成数，并只将对应目标标为失败', async () => {
  const runner = createLatencyBatchRunner(); const updates: LatencyBatchUpdate[] = [];
  const batch = runner.start([target('A'), target('A', GITHUB_LATENCY_URL, '开发')], {
    measure: async item => { if (item.target === DEFAULT_LATENCY_URL) throw new Error('timeout'); return 82; },
    onUpdate: update => updates.push(update),
  });
  await batch.done;
  expect(updates.at(-1)?.results.map(result => [result.target, result.delay])).toEqual([[DEFAULT_LATENCY_URL, null], [GITHUB_LATENCY_URL, 82]]);
  expect(updates.at(-1)?.progress.completed).toBe(2);
});

it('批量测速延迟到统一发布时才更新store，单节点旧调用仍立即发布', async () => {
  vi.mocked(api.mihomo).mockResolvedValue({ delay: 42 });
  const before = useApp.getState().groups;
  const delay = await useApp.getState().testDelay('A', DEFAULT_LATENCY_URL, { publish: false });
  expect(delay).toBe(42); expect(useApp.getState().groups).toBe(before);
  useApp.getState().publishDelayBatch([{ node: 'A', target: DEFAULT_LATENCY_URL, delay }]);
  expect(useApp.getState().groups[0].nodes[0].delay).toBe(42);
  expect(useApp.getState().groups[1].nodes[0].delay).toBeNull();
  vi.mocked(api.mihomo).mockResolvedValue({ delay: 64 });
  await useApp.getState().testDelay('A');
  expect(useApp.getState().groups[0].nodes[0].delay).toBe(64);
});

it('调用方失效后GitHub不再补查详情，也不发布过期结果', async () => {
  let resolve!: (value: unknown) => void; let current = true;
  vi.mocked(api.mihomo).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const before = useApp.getState().groups;
  const request = useApp.getState().testDelay('A', GITHUB_LATENCY_URL, { isCurrent: () => current });
  current = false; resolve({ delay: 42 }); await request;
  expect(api.mihomo).toHaveBeenCalledTimes(1);
  expect(useApp.getState().groups).toBe(before);
});

it('取消后新批次同节点及目标等待旧请求结束，不复用过期结果', async () => {
  const runner = createLatencyBatchRunner();
  const pending = new Map<string, (delay: number) => void>();
  const started: string[] = [];
  const measure = (item: { node: string }) => new Promise<number>(resolve => { started.push(item.node); pending.set(item.node, resolve); });
  const old = runner.start(['A', 'B', 'C'].map(node => target(node)), { measure, onUpdate: () => {} });
  old.cancel(true);
  const updates: LatencyBatchUpdate[] = [];
  const next = runner.start(['B', 'X', 'Y'].map(node => target(node)), { measure, onUpdate: update => updates.push(update) });
  pending.get('A')!(10); await tick();
  expect(started.filter(name => name === 'B')).toHaveLength(1);
  expect(started).toContain('X');
  pending.get('B')!(999); pending.get('C')!(30); await tick();
  expect(started.filter(name => name === 'B')).toHaveLength(2);
  pending.get('B')!(20); pending.get('X')!(40); pending.get('Y')!(50); await next.done;
  expect(updates.flatMap(update => update.results).some(result => result.delay === 999)).toBe(false);
});
