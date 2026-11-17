// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWindowVisible } from '../src/core/window-activity';
import { useRouteDiagnostics } from '../src/core/use-diagnostics';
import { api } from '../src/core/api';
import { checkWebRtc } from '../src/core/selfcheck';

const native = vi.hoisted(() => ({ listen: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('../src/core/api', () => ({ isTauri: true, api: {
  leakCheckIp: vi.fn(), probeService: vi.fn(), checkIpQuality: vi.fn(), leakCheckDns: vi.fn(), mihomo: vi.fn(),
} }));
vi.mock('../src/core/selfcheck', async original => ({ ...await original<typeof import('../src/core/selfcheck')>(), checkWebRtc: vi.fn(async () => { throw new Error('unavailable'); }) }));
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement('div'));
  vi.mocked(api.leakCheckIp).mockResolvedValue({ direct: '1.1.1.1', proxied: '2.2.2.2' });
  vi.mocked(api.probeService).mockResolvedValue({ ok: true, latency_ms: 12 } as any);
  vi.mocked(api.checkIpQuality).mockResolvedValue({ country: 'Japan' } as any);
  vi.mocked(api.leakCheckDns).mockResolvedValue({ kernel_alive: true } as any);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.clearAllMocks(); });

it('隐藏事件优先于过期的初始查询，卸载只取消订阅一次', async () => {
  let event!: (e: { payload: boolean }) => void;
  let queried!: (v: boolean) => void;
  const unlisten = vi.fn();
  native.listen.mockImplementation(async (_name, fn) => { event = fn; return unlisten; });
  native.invoke.mockImplementation(() => new Promise(r => { queried = r; }));
  let visible = true;
  function View() { visible = useWindowVisible(); return null; }
  await act(async () => root.render(createElement(View)));
  await act(async () => { event({ payload: false }); queried(true); });
  expect(visible).toBe(false);
  await act(async () => root.unmount());
  expect(unlisten).toHaveBeenCalledTimes(1);
  root = createRoot(document.createElement('div'));
});

it('稳定出口只诊断一次，切页复用缓存，WebRTC异常也能结束自检', async () => {
  let result!: ReturnType<typeof useRouteDiagnostics>;
  function View({ active = true, routeKey = 'A' }) {
    result = useRouteDiagnostics({ active, connected: true, routeKey, mixedPort: 1, dnsPort: 2, tun: true, githubNode: 'A' });
    return null;
  }
  await act(async () => root.render(createElement(View, {})));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(result.leakPhase).toBe('done');
  expect(api.leakCheckIp).toHaveBeenCalledTimes(1);
  expect(api.probeService).toHaveBeenCalledTimes(5);
  await act(async () => root.render(createElement(View, { active: false })));
  await act(async () => vi.advanceTimersByTimeAsync(600_000));
  await act(async () => root.render(createElement(View, { active: true })));
  await act(async () => vi.advanceTimersByTimeAsync(600_000));
  expect(api.leakCheckIp).toHaveBeenCalledTimes(1);
  expect(api.checkIpQuality).toHaveBeenCalledTimes(1);
  await act(async () => root.render(createElement(View, { routeKey: 'B' })));
  expect(result.egress).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.leakCheckIp).toHaveBeenCalledTimes(2);
  vi.mocked(api.leakCheckIp).mockResolvedValue({ direct: '1.1.1.1', proxied: '3.3.3.3' });
  await act(async () => result.loadIpQuality());
  expect(result.egress).toBeNull();
  expect(result.ipQuality).toBeNull();
  expect(result.leakPhase).toBe('idle');
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(result.egress).toBe('3.3.3.3');
  expect(api.checkIpQuality).toHaveBeenLastCalledWith('3.3.3.3');
  expect(api.leakCheckIp).toHaveBeenCalledTimes(3);
  expect(api.probeService).toHaveBeenCalledTimes(15);
});

it('旧出口的慢请求在A→B→A后不能启动后续诊断或覆盖结果', async () => {
  let finish!: (v: any) => void;
  vi.mocked(api.leakCheckIp).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  let result!: ReturnType<typeof useRouteDiagnostics>;
  function View({ routeKey }: { routeKey: string }) {
    result = useRouteDiagnostics({ active: true, connected: true, routeKey, mixedPort: 1, dnsPort: 2, tun: true, githubNode: 'A' });
    return null;
  }
  await act(async () => root.render(createElement(View, { routeKey: 'A:1' })));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  await act(async () => root.render(createElement(View, { routeKey: 'B:2' })));
  await act(async () => root.render(createElement(View, { routeKey: 'A:3' })));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  await act(async () => finish({ proxied: 'stale', direct: 'old' }));
  expect(result.egress).toBe('2.2.2.2');
  expect(api.checkIpQuality).toHaveBeenCalledTimes(1);
  expect(api.checkIpQuality).toHaveBeenCalledWith('2.2.2.2');
});

it('探测命令异常保持未验证与原因，手动刷新恢复且不增加周期探测', async () => {
  vi.mocked(api.probeService).mockRejectedValueOnce(new Error('控制器认证失败'));
  let result!: ReturnType<typeof useRouteDiagnostics>;
  function View() {
    result = useRouteDiagnostics({ active: true, connected: true, routeKey: 'A', mixedPort: 1, dnsPort: 2, tun: true, githubNode: 'A' });
    return null;
  }
  await act(async () => root.render(createElement(View)));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(result.serviceMap.google).toMatchObject({ ok: false, status: 'error', detail: '控制器认证失败' });
  await act(async () => result.runServiceProbe());
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(result.serviceMap.google.ok).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(600_000));
  expect(api.probeService).toHaveBeenCalledTimes(10);
});

it('STUN 运行规则与 WebView 能力独立展示，切页复用核验，不在后台重复读取', async () => {
  vi.mocked(checkWebRtc).mockResolvedValue({ scope: 'host', supported: false, status: 'unsupported', publicIps: [] });
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => path === '/configs'
    ? { mode: 'rule', tun: { enable: true, 'auto-route': true, 'strict-route': true } }
    : { rules: [
      { type: 'DomainKeyword', payload: 'stun', proxy: 'REJECT-DROP' },
      ...['3478-3479', '5349-5350', '19302-19309'].map(payload => ({ type: 'DstPort', payload, proxy: 'REJECT-DROP' })),
      { type: 'DomainSuffix', payload: 'turn.twilio.com', proxy: 'REJECT-DROP' },
    ] });
  let result!: ReturnType<typeof useRouteDiagnostics>;
  function View({ active = true }) {
    result = useRouteDiagnostics({ active, connected: true, routeKey: 'protected', mixedPort: 1, dnsPort: 2, tun: true, githubNode: 'A', blockWebRtc: true });
    return null;
  }
  await act(async () => root.render(createElement(View)));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(result.leakRows.find(r => r.id === 'stun')?.status).toBe('ok');
  expect(result.leakRows.find(r => r.id === 'webrtc')?.text).toContain('不支持');
  expect(checkWebRtc).toHaveBeenLastCalledWith(7000, { stun: false });
  await act(async () => root.render(createElement(View, { active: false })));
  await act(async () => vi.advanceTimersByTimeAsync(600_000));
  await act(async () => root.render(createElement(View)));
  await act(async () => vi.advanceTimersByTimeAsync(600_000));
  expect(api.mihomo).toHaveBeenCalledTimes(2);
  expect(checkWebRtc).toHaveBeenCalledOnce();
});
