// @vitest-environment happy-dom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';
import { useCurrentNodeLatency } from '../src/bootstrap/use-current-node-latency';

vi.mock('../src/core/api', async original => ({ ...await original<typeof import('../src/core/api')>(), isTauri: false }));

const initial = useApp.getInitialState();
let host: HTMLDivElement;
let root: Root;
let latency: ReturnType<typeof useCurrentNodeLatency>;
function Probe() { latency = useCurrentNodeLatency(); return createElement('span', null, latency.delay); }
const select = (node: string) => useApp.setState({ groups: [{ name: '常规', type: 'Selector', now: node,
  nodes: ['东京', '新加坡', 'DIRECT', 'REJECT'].map(name => ({ name, type: 'Trojan' })) }] });
const advance = (ms = 500) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const render = (strict = false) => act(async () => root.render(strict
  ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe)));

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(api, 'mihomo').mockResolvedValue({ delay: 66 });
  useApp.setState({ ...initial, kernelPhase: 'stopped', profiles: [], activeId: 'one',
    runtimeConfigTransition: false, settings: { ...initial.settings, mode: 'rule' }, toast: null });
  select('东京');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); useApp.setState(initial); vi.useRealTimers(); vi.restoreAllMocks();
});

it('连接成功后自动测速一次，普通重绘不重复请求且没有提示', async () => {
  await render(); await advance();
  expect(api.mihomo).not.toHaveBeenCalled();
  await act(async () => useApp.setState({ kernelPhase: 'running', connectedAt: 100 }));
  await advance();
  expect(latency.delay).toBe(66);
  expect(useApp.getState().groups[0].nodes[0].delay).toBe(66);
  expect(useApp.getState().toast).toBeNull();
  await render(); await advance(2000);
  expect(api.mihomo).toHaveBeenCalledTimes(1);
});

it('StrictMode 重放挂载后仍接受本次有效测速', async () => {
  useApp.setState({ kernelPhase: 'running' });
  await render(true); await advance();
  expect(latency.delay).toBe(66);
  expect(useApp.getState().groups[0].nodes[0].delay).toBe(66);
  expect(api.mihomo).toHaveBeenCalledTimes(1);
});

it('快速选择只测最后一个节点；在途请求结束前不并发，新节点随后补测', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.mihomo).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  useApp.setState({ kernelPhase: 'running' });
  await render(); await advance();
  await act(async () => select('新加坡')); await advance(100);
  await act(async () => select('东京')); await advance(100);
  await act(async () => select('新加坡')); await advance();
  expect(api.mihomo).toHaveBeenCalledTimes(1);
  await act(async () => finish({ delay: 22 }));
  expect(latency.delay).toBeNull();
  expect(useApp.getState().groups[0].nodes[0].delay).toBeUndefined();
  await advance();
  expect(api.mihomo).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.mihomo).mock.calls[1][1]).toContain(encodeURIComponent('新加坡'));
  expect(latency.delay).toBe(66);
});

it('A→B→A 不复用早先失败的显示状态', async () => {
  vi.mocked(api.mihomo).mockResolvedValueOnce({ delay: 0 });
  useApp.setState({ kernelPhase: 'running' });
  await render(); await advance();
  expect(latency.failed).toBe(true);
  await act(async () => select('新加坡'));
  await act(async () => select('东京'));
  expect(latency.failed).toBe(false);
  await advance();
  expect(latency.delay).toBe(66);
});

it.each(['DIRECT', 'REJECT'])('终端节点 %s 不发起自动测速', async node => {
  select(node); useApp.setState({ kernelPhase: 'running' });
  await render(); await advance();
  expect(latency.canTest).toBe(false);
  expect(api.mihomo).not.toHaveBeenCalled();
});

it('手动测速取消待执行自动测速，断开后旧结果不会发布', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.mihomo).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  useApp.setState({ kernelPhase: 'running' });
  await render();
  await act(async () => { void latency.measure(); void latency.measure(); });
  await advance(); expect(api.mihomo).toHaveBeenCalledTimes(1);
  await act(async () => useApp.setState({ kernelPhase: 'stopped' }));
  await act(async () => finish({ delay: 12 }));
  expect(latency.delay).toBeNull(); expect(useApp.getState().toast).toBeNull();
  expect(useApp.getState().groups[0].nodes[0].delay).toBeUndefined();
});

it('隐藏时暂停待执行测速，恢复可见时补测且不形成轮询', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  useApp.setState({ kernelPhase: 'running' });
  await render(); await advance(); expect(api.mihomo).not.toHaveBeenCalled();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await advance(); expect(latency.delay).toBe(66);
  await advance(5000); expect(api.mihomo).toHaveBeenCalledTimes(1);
});
