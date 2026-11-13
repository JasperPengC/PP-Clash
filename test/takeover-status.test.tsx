// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type SysProxyState } from '../src/core/api';
import { useTakeoverStatus, type TakeoverStatusInput } from '../src/core/use-takeover-status';

vi.mock('../src/core/api', () => ({ api: { getSystemProxy: vi.fn(), mihomo: vi.fn() } }));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
};
let host: HTMLDivElement;
let root: Root;
let input: TakeoverStatusInput;
function Status(props: TakeoverStatusInput) {
  const status = useTakeoverStatus(props);
  return createElement('div', null,
    createElement('span', { 'data-status': 'proxy' }, status.systemProxySubtitle),
    createElement('span', { 'data-status': 'tun' }, status.tunSubtitle));
}
const render = async (patch: Partial<TakeoverStatusInput> = {}) => {
  input = { ...input, ...patch };
  await act(async () => root.render(createElement(Status, input)));
};
const proxyText = () => host.querySelector('[data-status="proxy"]')?.textContent;
const tunText = () => host.querySelector('[data-status="tun"]')?.textContent;
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  input = { active: true, running: true, sysProxy: true, tun: true, revision: 'runtime-1/config-1' };
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: true, host: '127.0.0.1', port: 17890 });
  vi.mocked(api.mihomo).mockResolvedValue({ 'mixed-port': 7890, tun: { enable: true, device: 'utun7', stack: 'mixed' } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it('只展示系统实际端口和内核 TUN 接口/栈，TUN 不借用 mixed-port', async () => {
  await render();
  expect(proxyText()).toBe('端口 17890');
  expect(tunText()).toBe('utun7 · mixed');
  expect(api.getSystemProxy).toHaveBeenCalledTimes(1);
  expect(api.mihomo).toHaveBeenCalledExactlyOnceWith('GET', '/configs');
});

it('900ms 快照产生的新输入对象不会重读或增加轮询', async () => {
  await render();
  for (let tick = 0; tick < 4; tick++) {
    await act(async () => vi.advanceTimersByTimeAsync(900));
    await render();
  }
  expect(proxyText()).toBe('端口 17890');
  expect(tunText()).toBe('utun7 · mixed');
  expect(api.getSystemProxy).toHaveBeenCalledTimes(1);
  expect(api.mihomo).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('隐藏时不读取；重新可见才读取实际状态', async () => {
  await render({ active: false });
  expect(proxyText()).toBe('待确认'); expect(tunText()).toBe('待确认');
  expect(api.getSystemProxy).not.toHaveBeenCalled(); expect(api.mihomo).not.toHaveBeenCalled();
  await render({ active: true });
  expect(proxyText()).toBe('端口 17890'); expect(tunText()).toBe('utun7 · mixed');
});

it('关闭接管立即清除旧结果，不继续读取；重新开启重新确认', async () => {
  await render();
  await render({ sysProxy: false, tun: false });
  expect(proxyText()).toBe('未开启'); expect(tunText()).toBe('未开启');
  expect(api.getSystemProxy).toHaveBeenCalledTimes(1); expect(api.mihomo).toHaveBeenCalledTimes(1);
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: true, host: '127.0.0.1', port: 28901 });
  vi.mocked(api.mihomo).mockResolvedValue({ tun: { enable: true, device: 'utun9', stack: 'system' } });
  await render({ sysProxy: true, tun: true });
  expect(proxyText()).toBe('端口 28901'); expect(tunText()).toBe('utun9 · system');
});

it('停止内核后即使开关仍为开也不显示生效，恢复运行后重新读取', async () => {
  await render();
  await render({ running: false });
  expect(proxyText()).toBe('内核未运行'); expect(tunText()).toBe('内核未运行');
  expect(api.getSystemProxy).toHaveBeenCalledTimes(1); expect(api.mihomo).toHaveBeenCalledTimes(1);
  await render({ running: true });
  expect(api.getSystemProxy).toHaveBeenCalledTimes(2); expect(api.mihomo).toHaveBeenCalledTimes(2);
});

it('切换过程中清除旧观测，完成后再确认', async () => {
  await render();
  await render({ transitioning: true });
  expect(proxyText()).toBe('待确认'); expect(tunText()).toBe('待确认');
  expect(api.getSystemProxy).toHaveBeenCalledTimes(1); expect(api.mihomo).toHaveBeenCalledTimes(1);
  vi.mocked(api.getSystemProxy).mockRejectedValue(new Error('unavailable'));
  vi.mocked(api.mihomo).mockRejectedValue(new Error('unavailable'));
  await render({ transitioning: false });
  expect(proxyText()).toBe('待确认'); expect(tunText()).toBe('待确认');
  expect(api.getSystemProxy).toHaveBeenCalledTimes(2); expect(api.mihomo).toHaveBeenCalledTimes(2);
});

it('配置或运行代次变化立即清空旧结果，失败时不保留旧端口与接口', async () => {
  await render();
  const proxy = deferred<SysProxyState>(); const tun = deferred<unknown>();
  vi.mocked(api.getSystemProxy).mockReturnValueOnce(proxy.promise);
  vi.mocked(api.mihomo).mockReturnValueOnce(tun.promise);
  await render({ revision: 'runtime-2/config-2' });
  expect(proxyText()).toBe('待确认'); expect(tunText()).toBe('待确认');
  await act(async () => {
    proxy.resolve({ enabled: false, host: '127.0.0.1', port: 17890 });
    tun.resolve({ tun: { enable: false, device: 'utun7', stack: 'mixed' } });
  });
  expect(proxyText()).toBe('待确认'); expect(tunText()).toBe('待确认');
});

it.each(['hide', 'revision', 'toggle', 'transition'] as const)('%s 后迟到的旧响应不能覆盖重新确认的结果', async change => {
  const proxy = deferred<SysProxyState>(); const tun = deferred<unknown>();
  vi.mocked(api.getSystemProxy).mockReturnValueOnce(proxy.promise);
  vi.mocked(api.mihomo).mockReturnValueOnce(tun.promise);
  await render();
  if (change === 'hide') { await render({ active: false }); await render({ active: true }); }
  if (change === 'revision') { await render({ revision: 'config-2' }); await render({ revision: 'runtime-1/config-1' }); }
  if (change === 'toggle') { await render({ sysProxy: false, tun: false }); await render({ sysProxy: true, tun: true }); }
  if (change === 'transition') { await render({ transitioning: true }); await render({ transitioning: false }); }
  await act(async () => {
    proxy.resolve({ enabled: true, host: '127.0.0.1', port: 39999 });
    tun.resolve({ tun: { enable: true, device: 'stale0', stack: 'gvisor' } });
  });
  expect(proxyText()).toBe('端口 17890'); expect(tunText()).toBe('utun7 · mixed');
});

it('隐藏后完成的读取不会恢复已失效状态', async () => {
  const proxy = deferred<SysProxyState>(); const tun = deferred<unknown>();
  vi.mocked(api.getSystemProxy).mockReturnValueOnce(proxy.promise);
  vi.mocked(api.mihomo).mockReturnValueOnce(tun.promise);
  await render(); await render({ active: false });
  await act(async () => {
    proxy.resolve({ enabled: true, host: '127.0.0.1', port: 39999 });
    tun.resolve({ tun: { enable: true, device: 'stale0', stack: 'gvisor' } });
  });
  expect(proxyText()).toBe('待确认'); expect(tunText()).toBe('待确认');
});

it.each([0, -1, 65536, 1.5, NaN, '7890', null, undefined])('非法实际端口 %s 保持待确认', async port => {
  vi.mocked(api.getSystemProxy).mockResolvedValue({ enabled: true, host: '127.0.0.1', port } as SysProxyState);
  await render();
  expect(proxyText()).toBe('待确认'); expect(tunText()).toBe('utun7 · mixed');
});

it.each([null, [], {}, { enabled: false, port: 7890 }, { enabled: 'true', port: 7890 }])('非法或未开启的系统代理响应 %# 保持待确认', async response => {
  vi.mocked(api.getSystemProxy).mockResolvedValue(response as SysProxyState);
  await render(); expect(proxyText()).toBe('待确认');
});

it.each([
  null, [], {}, { tun: null }, { tun: { enable: false, device: 'utun7', stack: 'mixed' } },
  { tun: { enable: 'true', device: 'utun7', stack: 'mixed' } },
  { tun: { enable: true, device: '', stack: 'mixed' } },
  { tun: { enable: true, device: 7, stack: 'mixed' } },
  { tun: { enable: true, device: 'utun7' } },
  { tun: { enable: true, device: 'utun7', stack: {} } },
  { tun: { enable: true, device: 'utun7', stack: ' ' } },
])('未确认的 TUN 配置 %# 不冒充接口或端口', async response => {
  vi.mocked(api.mihomo).mockResolvedValue(response);
  await render(); expect(tunText()).toBe('待确认'); expect(proxyText()).toBe('端口 17890');
});

it.each(['proxy', 'tun'])('%s 读取失败不影响另一个已确认状态', async source => {
  if (source === 'proxy') vi.mocked(api.getSystemProxy).mockRejectedValue(new Error('unavailable'));
  else vi.mocked(api.mihomo).mockRejectedValue(new Error('unavailable'));
  await render();
  expect(proxyText()).toBe(source === 'proxy' ? '待确认' : '端口 17890');
  expect(tunText()).toBe(source === 'tun' ? '待确认' : 'utun7 · mixed');
});
