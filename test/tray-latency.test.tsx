// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TrayPanel } from '../src/components/TrayPanel';
import { subscribeRuntimeDisplayStatus } from '../src/core/runtime-display-events';
import { api, type TraySnapshot } from '../src/core/api';
import { DEFAULT_LATENCY_URL, GITHUB_LATENCY_URL } from '../src/core/latency';

vi.mock('../src/core/runtime-display-events', () => ({ subscribeRuntimeDisplayStatus: vi.fn(receive => { receive({ revision: 'test:1', transitioning: false }); return vi.fn(); }) }));

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: {
    traySnapshot: vi.fn(), trayAction: vi.fn(), mihomo: vi.fn(), getSystemProxy: vi.fn(),
  } };
});
let host: HTMLDivElement; let root: Root; let snapshot: TraySnapshot;
const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; };
const testButton = () => host.querySelector<HTMLButtonElement>('.tp-test')!;
const nodeRow = () => [...host.querySelectorAll<HTMLButtonElement>('.tp-node-item')].find(node => node.textContent?.includes('节点 B'))!;
const clickTest = async () => act(async () => testButton().click());
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  vi.mocked(subscribeRuntimeDisplayStatus).mockImplementation(receive => { receive({ revision: 'test:1', transitioning: false }); return vi.fn(); });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  snapshot = { running: true, sysProxy: true, tun: false, mode: 'rule', node: '节点 A', group: '常规',
    up: 0, down: 0, showSpeed: true, controllerPort: 9090, controllerSecret: '', activeProfile: 'profile-1',
    profiles: [{ id: 'profile-1', name: '订阅一' }, { id: 'profile-2', name: '订阅二' }],
    nodes: [{ name: '节点 A', delay: 21, selected: true }, { name: '节点 B', delay: 42, selected: false }] };
  vi.mocked(api.traySnapshot).mockImplementation(async () => snapshot);
  vi.mocked(api.trayAction).mockResolvedValue(undefined);
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: true, host: '127.0.0.1', port: 17890 });
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => path.includes('/delay?') ? { delay: 82 }
    : { extra: { [GITHUB_LATENCY_URL]: { Alive: true, History: [{ delay: 82 }] } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(['GitHub', '开发', 'GitHub 固定出口'])('托盘 %s 组展示并使用 GitHub 目标，要求 HTTP 200', async group => {
  snapshot = { ...snapshot, group };
  await act(async () => root.render(createElement(TrayPanel)));
  expect(host.textContent).toContain('GitHub');
  await clickTest();
  const request = new URL(String(vi.mocked(api.mihomo).mock.calls[0][1]), 'http://mock.test');
  expect(request.searchParams.get('url')).toBe(GITHUB_LATENCY_URL);
  expect(request.searchParams.get('expected')).toBe('200');
  expect(request.pathname).toMatch(/^\/proxies\/.+\/delay$/);
  expect(vi.mocked(api.mihomo).mock.calls.some(([, path]) => path.startsWith('/group/'))).toBe(false);
  expect(nodeRow().textContent).toContain('82 ms');
});

it('普通组保留常规目标，不附加 GitHub 的响应条件且不自动测速', async () => {
  await act(async () => root.render(createElement(TrayPanel)));
  await act(async () => vi.advanceTimersByTimeAsync(1800));
  expect(api.mihomo).not.toHaveBeenCalled();
  await clickTest();
  const request = new URL(String(vi.mocked(api.mihomo).mock.calls[0][1]), 'http://mock.test');
  expect(request.searchParams.get('url')).toBe(DEFAULT_LATENCY_URL);
  expect(request.searchParams.has('expected')).toBe(false);
  expect(api.trayAction).not.toHaveBeenCalled();
});

it.each(['null', 'error'])('托盘测速%s失败覆盖旧成功值并允许重试', async failure => {
  if (failure === 'null') vi.mocked(api.mihomo).mockResolvedValueOnce({ delay: null }).mockResolvedValueOnce({ delay: null });
  else vi.mocked(api.mihomo).mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('timeout'));
  await act(async () => root.render(createElement(TrayPanel)));
  await clickTest();
  expect(nodeRow().textContent).toContain('失败');
  expect(nodeRow().textContent).not.toContain('42 ms');
  expect(testButton().disabled).toBe(false);
  await clickTest(); expect(nodeRow().textContent).toContain('82 ms');
});

it.each(['group', 'profile'])('托盘%s变化后丢弃旧测速回包，新目标可独立测速', async change => {
  const old = deferred<unknown>(); vi.mocked(api.mihomo).mockReturnValueOnce(old.promise);
  await act(async () => root.render(createElement(TrayPanel)));
  await clickTest(); expect(testButton().disabled).toBe(true);
  snapshot = { ...snapshot, ...(change === 'group' ? { group: '开发' } : { activeProfile: 'profile-2' }),
    nodes: snapshot.nodes.map(node => ({ ...node, delay: null })) };
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(testButton().disabled).toBe(false);
  await clickTest(); expect(nodeRow().textContent).toContain('82 ms');
  await act(async () => old.resolve({ delay: 999 }));
  expect(nodeRow().textContent).not.toContain('999 ms');
  expect(nodeRow().textContent).toContain('82 ms');
  expect(vi.mocked(api.mihomo).mock.calls.filter(([, path]) => path.includes('/delay?'))).toHaveLength(4);
});

it.each([false, undefined])('GitHub返回正延迟但Alive=%s时显示失败，不信任未确认的结果', async alive => {
  snapshot = { ...snapshot, group: '开发' };
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => path.includes('/delay?') ? { delay: 82 }
    : { extra: { [GITHUB_LATENCY_URL]: { Alive: alive, History: [{ delay: 82 }] } } });
  await act(async () => root.render(createElement(TrayPanel)));
  await clickTest();
  expect(nodeRow().textContent).toContain('失败');
  expect(nodeRow().textContent).not.toContain('82 ms');
  expect(vi.mocked(api.mihomo).mock.calls.some(([, path]) => path === `/proxies/${encodeURIComponent('节点 B')}`)).toBe(true);
});

it('托盘逐节点测速最多三个并发，旧批次失效后不再派发剩余节点', async () => {
  snapshot = { ...snapshot, nodes: Array.from({ length: 7 }, (_, index) => ({ name: `节点 ${index}`, delay: null, selected: index === 0 })) };
  const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
  let inFlight = 0; let maximum = 0;
  vi.mocked(api.mihomo).mockImplementation(async () => {
    inFlight++; maximum = Math.max(maximum, inFlight);
    const request = deferred<unknown>(); pending.push(request);
    const result = await request.promise; inFlight--; return result;
  });
  await act(async () => root.render(createElement(TrayPanel)));
  await clickTest();
  expect(pending).toHaveLength(3);
  snapshot = { ...snapshot, activeProfile: 'profile-2' };
  await act(async () => vi.advanceTimersByTimeAsync(900));
  await clickTest();
  expect(pending).toHaveLength(3);
  await act(async () => { for (const request of pending.slice(0, 3)) request.resolve({ delay: 21 }); });
  expect(pending).toHaveLength(6);
  await act(async () => { for (const request of pending.slice(3, 6)) request.resolve({ delay: 21 }); });
  await act(async () => { for (const request of pending.slice(6, 9)) request.resolve({ delay: 21 }); });
  await act(async () => { for (const request of pending.slice(9)) request.resolve({ delay: 21 }); });
  expect(maximum).toBe(3);
  expect(pending).toHaveLength(10);
  expect(testButton().disabled).toBe(false);
  expect(vi.mocked(api.mihomo).mock.calls.every(([method, path]) => method === 'GET' && path.startsWith('/proxies/'))).toBe(true);
});

it.each(['blur', 'hidden', 'close'])('托盘%s后旧请求不再读取GitHub详情或派发排队节点', async reason => {
  snapshot = { ...snapshot, group: '开发', nodes: Array.from({ length: 7 }, (_, index) => ({ name: `节点 ${index}`, delay: null, selected: index === 0 })) };
  const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
  vi.mocked(api.mihomo).mockImplementation(async () => {
    const request = deferred<unknown>(); pending.push(request); return request.promise;
  });
  await act(async () => root.render(createElement(TrayPanel)));
  await clickTest(); expect(pending).toHaveLength(3);
  await act(async () => {
    if (reason === 'hidden') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    } else if (reason === 'close') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    } else {
      vi.mocked(document.hasFocus).mockReturnValue(false);
      window.dispatchEvent(new Event('blur'));
    }
  });
  await act(async () => { for (const request of pending.slice(0, 3)) request.resolve({ delay: 82 }); });
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(api.mihomo).toHaveBeenCalledTimes(3);
  expect(vi.mocked(api.mihomo).mock.calls.every(([, path]) => path.includes('/delay?'))).toBe(true);
});

it('同订阅分组重新聚焦清除旧测速缓存且不自动测速', async () => {
  snapshot = { ...snapshot, nodes: snapshot.nodes.map(node => ({ ...node, delay: null })) };
  await act(async () => root.render(createElement(TrayPanel)));
  await clickTest(); expect(nodeRow().textContent).toContain('82 ms');
  await act(async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
  });
  await act(async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(900);
  });
  expect(nodeRow().textContent).not.toContain('82 ms');
  expect(nodeRow().textContent).toContain('未测');
  expect(api.mihomo).toHaveBeenCalledTimes(2);
});

it('隐藏前的慢快照不能在重新聚焦后恢复旧节点延迟', async () => {
  const old = deferred<TraySnapshot>();
  const oldSnapshot = { ...snapshot };
  vi.mocked(api.traySnapshot).mockReturnValueOnce(old.promise);
  await act(async () => root.render(createElement(TrayPanel)));
  await act(async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    old.resolve(oldSnapshot);
  });
  expect(host.textContent).not.toContain('42 ms');
  snapshot = { ...snapshot, nodes: snapshot.nodes.map(node => ({ ...node, delay: null })) };
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(nodeRow().textContent).toContain('未测');
  expect(api.mihomo).not.toHaveBeenCalled();
});

it('托盘显示实际端口和 TUN 接口，900ms 新快照不重复读配置且不自动测速', async () => {
  snapshot = { ...snapshot, tun: true };
  vi.mocked(api.mihomo).mockResolvedValue({ 'mixed-port': 7890, tun: { enable: true, device: 'utun7', stack: 'mixed' } });
  vi.mocked(api.traySnapshot).mockImplementation(async () => ({ ...snapshot }));
  await act(async () => root.render(createElement(TrayPanel)));
  await act(async () => vi.advanceTimersByTimeAsync(2700));
  expect(host.textContent).toContain('端口 17890');
  expect(host.textContent).toContain('utun7 · mixed');
  expect(api.getSystemProxy).toHaveBeenCalledTimes(1);
  expect(api.mihomo).toHaveBeenCalledExactlyOnceWith('GET', '/configs');
  expect(vi.mocked(api.mihomo).mock.calls.some(([, path]) => path.includes('/delay?'))).toBe(false);
});

it('托盘分组/节点快照不使生效参数失效，订阅或控制端变化会重新确认', async () => {
  await act(async () => root.render(createElement(TrayPanel)));
  snapshot = { ...snapshot, group: '开发', node: '节点 B' };
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(api.getSystemProxy).toHaveBeenCalledTimes(1);
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: true, host: '127.0.0.1', port: 28901 });
  snapshot = { ...snapshot, activeProfile: 'profile-2' };
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(host.textContent).toContain('端口 28901');
  expect(api.getSystemProxy).toHaveBeenCalledTimes(2);
  snapshot = { ...snapshot, controllerPort: 9091 };
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(api.getSystemProxy).toHaveBeenCalledTimes(3);
});

it('托盘开关处理中清除旧端口，处理结束后重新确认', async () => {
  await act(async () => root.render(createElement(TrayPanel)));
  expect(host.textContent).toContain('端口 17890');
  const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="系统代理"]')!;
  await act(async () => toggle.click());
  expect(host.textContent).not.toContain('端口 17890');
  expect(host.querySelector('.tp-row-subtitle')?.textContent).toBe('待确认');
  expect(api.getSystemProxy).toHaveBeenCalledTimes(1);
  vi.mocked(api.getSystemProxy).mockRejectedValue(new Error('unavailable'));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.getSystemProxy).toHaveBeenCalledTimes(2);
  expect(host.querySelector('.tp-row-subtitle')?.textContent).toBe('待确认');
});

it('托盘隐藏后迟到的端口不能写回，重新显示后独立确认', async () => {
  const old = deferred<{ enabled: boolean; host: string; port: number }>();
  vi.mocked(api.getSystemProxy).mockReturnValueOnce(old.promise);
  await act(async () => root.render(createElement(TrayPanel)));
  await act(async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    old.resolve({ enabled: true, host: '127.0.0.1', port: 39999 });
  });
  expect(host.textContent).not.toContain('39999');
  await act(async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(900);
  });
  expect(host.textContent).toContain('端口 17890');
  expect(api.getSystemProxy).toHaveBeenCalledTimes(2);
});

it('同订阅配置重载事件使旧端口失效，沿已有快照循环确认新参数', async () => {
  await act(async () => root.render(createElement(TrayPanel)));
  expect(host.textContent).toContain('端口 17890');
  const receive = vi.mocked(subscribeRuntimeDisplayStatus).mock.calls[0][0];
  const reads = vi.mocked(api.getSystemProxy).mock.calls.length;
  await act(async () => receive({ revision: 'test:2', transitioning: true }));
  expect(host.textContent).not.toContain('端口 17890');
  await act(async () => vi.advanceTimersByTimeAsync(1800));
  expect(api.getSystemProxy).toHaveBeenCalledTimes(reads);
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: true, host: '127.0.0.1', port: 27890 });
  await act(async () => receive({ revision: 'test:3', transitioning: false }));
  expect(host.textContent).not.toContain('端口 17890');
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(host.textContent).toContain('端口 27890');
  await act(async () => vi.advanceTimersByTimeAsync(2700));
  expect(api.getSystemProxy).toHaveBeenCalledTimes(reads + 1);
});
