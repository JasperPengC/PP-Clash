import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPolling } from '../src/core/polling';
import { DiagnosticCache, DiagnosticEpoch } from '../src/core/diagnostic-cache';

afterEach(() => vi.useRealTimers());

describe('展示任务生命周期', () => {
  it('慢请求不会重叠，停止后不再调度', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let calls = 0;
    const stop = startPolling(() => { calls++; return new Promise<void>(r => { finish = r; }); }, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
  });
  it('恢复展示立即刷新，失败后仍能继续采样', async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const stop = startPolling(task, 1000);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('出口诊断缓存', () => {
  it('A→B→A 会丢弃最初 A 的结果并重新检测', async () => {
    const epochs = new DiagnosticEpoch();
    const first = epochs.update('A');
    const cache = new DiagnosticCache<string>();
    let finish!: (value: string) => void;
    const old = cache.run(String(first), () => new Promise<string>(r => { finish = r; }));
    epochs.update('B');
    const latest = epochs.update('A');
    expect(epochs.isCurrent(first)).toBe(false);
    expect(await cache.run(String(latest), async () => 'new-A')).toBe('new-A');
    finish('old-A'); await old;
    expect(cache.peek(String(latest))).toBe('new-A');
  });
  it('同一出口不会因切换页面重复检测，变化后旧结果不能覆盖新结果', async () => {
    const cache = new DiagnosticCache<number>();
    let oldDone!: (v: number) => void;
    const first = cache.run('A', () => new Promise<number>(r => { oldDone = r; }));
    const second = cache.run('B', async () => 2);
    expect(await second).toBe(2);
    oldDone(1);
    await first;
    expect(cache.peek('B')).toBe(2);
    expect(cache.peek('A')).toBeUndefined();
    let calls = 0;
    expect(await cache.run('B', async () => { calls++; return 3; })).toBe(2);
    expect(calls).toBe(0);
    expect(await cache.run('B', async () => 3, true)).toBe(3);
  });
  it('并发调用只发一轮请求', async () => {
    const cache = new DiagnosticCache<number>();
    let done!: (v: number) => void;
    let calls = 0;
    const work = () => { calls++; return new Promise<number>(r => { done = r; }); };
    const first = cache.run('A', work);
    const second = cache.run('A', work);
    done(7);
    expect(await Promise.all([first, second])).toEqual([7, 7]);
    expect(calls).toBe(1);
  });
});
