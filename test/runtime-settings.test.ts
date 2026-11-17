import { expect, it, vi } from 'vitest';
import { createSettingsApplication } from '../src/application/apply-runtime-settings';
import { DEFAULT_SETTINGS } from '../src/domain/settings';

function setup() {
  const state = { settings: { ...DEFAULT_SETTINGS }, kernelPhase: 'running' as 'running' | 'stopped', hasProfile: true };
  const calls: string[] = [];
  let generation = 1;
  let apply = async () => true;
  let restart = async () => true;
  const run = createSettingsApplication({
    read: () => state, token: () => generation, current: token => token === generation,
    update: patch => { state.settings = { ...state.settings, ...patch }; },
    invalidate: () => { calls.push('invalidate'); },
    apply: () => { calls.push('apply'); return apply(); },
    restart: () => { calls.push('restart'); return restart(); },
  });
  return { state, calls, run, cancel: () => generation++, apply: (fn: typeof apply) => { apply = fn; }, restart: (fn: typeof restart) => { restart = fn; } };
}
const rollback = { config: true, restart: 'always' as const, exception: true };

it('保存、生成、重启按顺序执行；停机只生成待生效配置', async () => {
  const s = setup();
  expect(await s.run({ mixedPort: 9000 })).toMatchObject({ status: 'applied' });
  expect(s.calls).toEqual(['apply', 'restart']); expect(s.state.settings.mixedPort).toBe(9000);
  s.state.kernelPhase = 'stopped'; s.calls.length = 0;
  expect(await s.run({ dnsPort: 1054 })).toMatchObject({ status: 'saved' });
  expect(s.calls).toEqual(['apply']);
});

it('无订阅时只保存；允许接管既有运行内核的调用仍可生成配置', async () => {
  const s = setup(); s.state.hasProfile = false;
  expect(await s.run({ dnsPort: 1054 })).toMatchObject({ status: 'deferred' });
  expect(s.calls).toEqual([]);
  expect(await s.run({}, { allowRunningWithoutProfile: true })).toMatchObject({ status: 'applied' });
});

it('配置失败按调用方策略回滚修改字段，不触碰无关设置，也不重启', async () => {
  const s = setup(); s.apply(async () => { s.state.settings.theme = 'dark'; return false; });
  expect(await s.run({ mixedPort: 9000 }, { rollback })).toMatchObject({ status: 'failed', stage: 'config', rolledBack: true });
  expect(s.state.settings.mixedPort).toBe(DEFAULT_SETTINGS.mixedPort);
  expect(s.state.settings.theme).toBe('dark'); expect(s.calls).toEqual(['apply', 'invalidate']);
});

it('DNS 失败保留新设置以便重试；模式重启失败仅在内核仍运行时回滚', async () => {
  const s = setup(); s.restart(async () => false);
  expect(await s.run({ dnsPort: 1054 })).toMatchObject({ status: 'failed', rolledBack: false, stage: 'restart' });
  expect(s.state.settings.dnsPort).toBe(1054);
  expect(await s.run({ mode: 'global' }, { rollback: { restart: 'if-running' } })).toMatchObject({ rolledBack: true });
  expect(s.state.settings.mode).toBe('rule');
  s.restart(async () => { s.state.kernelPhase = 'stopped'; return false; });
  expect(await s.run({ mode: 'global' }, { rollback: { restart: 'if-running' } })).toMatchObject({ rolledBack: false });
  expect(s.state.settings.mode).toBe('global');
});

it('生命周期过期的配置回包不能重启或回滚新状态', async () => {
  const s = setup(); s.apply(async () => { s.cancel(); s.state.settings.dnsPort = 4000; return false; });
  expect(await s.run({ dnsPort: 1054 }, { rollback })).toEqual({ status: 'stale' });
  expect(s.state.settings.dnsPort).toBe(4000); expect(s.calls).toEqual(['apply']);
});

it('同一字段的连续修改按顺序执行，后发设置最终生效', async () => {
  const s = setup(); let finish!: (value: boolean) => void;
  s.apply(() => new Promise(resolve => { finish = resolve; }));
  const old = s.run({ mode: 'global' }, { rollback });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  s.apply(async () => true);
  const next = s.run({ mode: 'direct' }, { rollback });
  finish(false);
  expect(await old).toMatchObject({ status: 'failed', rolledBack: true });
  expect(await next).toMatchObject({ status: 'applied' });
  expect(s.state.settings.mode).toBe('direct');
});

it('不同字段的并发失败均恢复原值，后发请求不取消先发回滚', async () => {
  const s = setup(); let finish!: (value: boolean) => void;
  s.apply(() => new Promise(resolve => { finish = resolve; }));
  const port = s.run({ mixedPort: 9000 }, { rollback });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  s.apply(async () => false);
  const mode = s.run({ mode: 'global' }, { rollback });
  finish(false);
  const results = await Promise.all([port, mode]);
  expect(results).toMatchObject([
    { status: 'failed', stage: 'config', rolledBack: true },
    { status: 'failed', stage: 'config', rolledBack: true },
  ]);
  expect(s.state.settings.mixedPort).toBe(DEFAULT_SETTINGS.mixedPort);
  expect(s.state.settings.mode).toBe(DEFAULT_SETTINGS.mode);
  expect(s.calls).toEqual(['apply', 'invalidate', 'apply', 'invalidate']);
});

it('生命周期变化取消排队设置，不能重新写入已恢复的会话', async () => {
  const s = setup(); let finish!: (value: boolean) => void;
  s.apply(() => new Promise(resolve => { finish = resolve; }));
  const port = s.run({ mixedPort: 9000 }, { rollback });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  s.apply(async () => true);
  const mode = s.run({ mode: 'global' }, { rollback });
  s.cancel(); s.state.settings = { ...DEFAULT_SETTINGS };
  finish(false);
  expect(await Promise.all([port, mode])).toEqual([{ status: 'stale' }, { status: 'stale' }]);
  expect(s.state.settings).toEqual(DEFAULT_SETTINGS);
  expect(s.calls).toEqual(['apply']);
});

it('抛错转换成结构化失败，并执行明确要求的回滚', async () => {
  const s = setup(); s.apply(async () => { throw Error('offline'); });
  expect(await s.run({ dnsPort: 1054 }, { rollback })).toMatchObject({ status: 'failed', stage: 'exception', rolledBack: true });
  expect(s.state.settings.dnsPort).toBe(DEFAULT_SETTINGS.dnsPort);
});
