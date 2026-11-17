// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emit, listen } from '@tauri-apps/api/event';
import { installRuntimeDisplayPublisher, subscribeRuntimeDisplayStatus } from '../src/core/runtime-display-events';

vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const cleanups: Array<() => void> = [];
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const deliver = (name: string, payload: unknown) => handlers.get(`runtime-display://${name}`)?.({ payload });
const lastRequest = () => vi.mocked(emit).mock.calls.filter(([name]) => name === 'runtime-display://request').at(-1)![1];
const snapshot = (sequence: number, transitioning = false, session = 'main') => ({ session, sequence, transitioning });

beforeEach(() => {
  vi.resetAllMocks(); handlers.clear();
  vi.mocked(emit).mockResolvedValue(undefined);
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    handlers.set(String(name), handler as (event: { payload: unknown }) => void);
    return () => { handlers.delete(String(name)); };
  });
});
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });

it('只在运行配置变化时广播，回复当前代次，不传出私有配置键', async () => {
  let state = { key: 'private-controller-secret:1', transitioning: false };
  let changed!: () => void;
  const unsubscribe = vi.fn();
  cleanups.push(installRuntimeDisplayPublisher(() => state, listener => { changed = listener; return unsubscribe; }));
  await flush();
  const initial = vi.mocked(emit).mock.calls.length;
  changed(); changed();
  expect(emit).toHaveBeenCalledTimes(initial);
  state = { key: 'private-controller-secret:2', transitioning: true }; changed();
  const update = vi.mocked(emit).mock.lastCall![1] as ReturnType<typeof snapshot>;
  expect(update.transitioning).toBe(true);
  expect(JSON.stringify(update)).not.toContain('private-controller');
  deliver('request', 'request-id');
  expect(emit).toHaveBeenLastCalledWith('runtime-display://response', { request: 'request-id', snapshot: update });
});

it('握手前不确认生效数据，旧代次不能撤回切换状态', async () => {
  const receive = vi.fn(); cleanups.push(subscribeRuntimeDisplayStatus(receive)); await flush();
  expect(receive.mock.lastCall![0].transitioning).toBe(true);
  deliver('response', { request: lastRequest(), snapshot: snapshot(4) });
  deliver('changed', snapshot(6, true));
  deliver('changed', snapshot(5, false));
  expect(receive.mock.lastCall![0]).toEqual({ revision: 'main:6', transitioning: true });
  deliver('changed', snapshot(7));
  expect(receive.mock.lastCall![0]).toEqual({ revision: 'main:7', transitioning: false });
});

it('握手过程中已收到更新时使用较新的代次', async () => {
  const receive = vi.fn(); cleanups.push(subscribeRuntimeDisplayStatus(receive)); await flush();
  deliver('changed', snapshot(12, true));
  deliver('response', { request: lastRequest(), snapshot: snapshot(11, false) });
  expect(receive.mock.lastCall![0]).toEqual({ revision: 'main:12', transitioning: true });
});

it('主窗口重载重新握手，旧会话和过期响应不会恢复旧参数', async () => {
  const receive = vi.fn(); cleanups.push(subscribeRuntimeDisplayStatus(receive)); await flush();
  const firstRequest = lastRequest();
  deliver('response', { request: firstRequest, snapshot: snapshot(80) });
  deliver('changed', snapshot(1, true, 'reloaded'));
  const request = lastRequest();
  deliver('response', { request: firstRequest, snapshot: snapshot(81) });
  expect(receive.mock.lastCall![0].transitioning).toBe(true);
  deliver('response', { request, snapshot: snapshot(2, false, 'reloaded') });
  expect(receive.mock.lastCall![0]).toEqual({ revision: 'reloaded:2', transitioning: false });
});

it('注销后的事件与迟到注册不会产生回调', async () => {
  const receive = vi.fn(); const dispose = subscribeRuntimeDisplayStatus(receive);
  dispose(); await flush(); deliver('changed', snapshot(1));
  expect(receive).not.toHaveBeenCalled(); expect(handlers.size).toBe(0);
});

it('初始请求早于主窗口就绪时，就绪广播重新请求并恢复确认', async () => {
  const receive = vi.fn(); cleanups.push(subscribeRuntimeDisplayStatus(receive)); await flush();
  const initial = lastRequest();
  vi.mocked(emit).mockImplementation(async (name, payload) => {
    if (name === 'runtime-display://request') deliver('response', { request: payload, snapshot: snapshot(1) });
  });
  deliver('changed', snapshot(1));
  await flush();
  expect(receive.mock.lastCall![0]).toEqual({ revision: 'main:1', transitioning: false });
  expect(vi.mocked(emit).mock.calls.filter(([name]) => name === 'runtime-display://request')).toHaveLength(2);
  expect(lastRequest()).not.toBe(initial);
});

it('新会话广播后旧主窗口不能用先到的握手响应抢回状态', async () => {
  const receive = vi.fn(); cleanups.push(subscribeRuntimeDisplayStatus(receive)); await flush();
  const oldRequest = lastRequest();
  deliver('changed', snapshot(1, true, 'new-main'));
  const newRequest = lastRequest();
  deliver('response', { request: oldRequest, snapshot: snapshot(20, false, 'old-main') });
  deliver('response', { request: newRequest, snapshot: snapshot(1, true, 'new-main') });
  expect(receive.mock.lastCall![0]).toEqual({ revision: 'new-main:1', transitioning: true });
});
