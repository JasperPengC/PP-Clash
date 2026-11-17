import { afterEach, expect, it, vi } from 'vitest';
import { checkWebRtc, describeWebRtc } from '../src/core/selfcheck';
class Peer {
  static last: Peer;
  onicecandidate: ((event: any) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  onicecandidateerror: ((event: any) => void) | null = null;
  iceGatheringState = 'new';
  constructor(readonly config: RTCConfiguration) { Peer.last = this; }
  createDataChannel() {}
  createOffer() { return Promise.resolve({}); }
  setLocalDescription() { return Promise.resolve(); }
  close = vi.fn();
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('防护开启时只收集本地候选，不再请求已被阻断的 STUN', async () => {
  vi.stubGlobal('RTCPeerConnection', Peer);
  const result = checkWebRtc(100, { stun: false });
  expect(Peer.last.config.iceServers).toEqual([]);
  Peer.last.onicecandidate?.({ candidate: null });
  const collected = await result;
  expect(collected).toMatchObject({ scope: 'host', status: 'complete' });
  expect(describeWebRtc(collected, { tun: true, blockWebRtc: true }).text).toContain('本地候选');
});

it('本地候选超时不再被解释为 STUN 故障或阻断成功', () => {
  const described = describeWebRtc({ scope: 'host', supported: true, status: 'timeout', publicIps: [] }, { tun: true, blockWebRtc: true });
  expect(described.status).toBe('warn');
  expect(described.text).toContain('本地候选');
  expect(described.text).not.toContain('STUN');
});
it('WebRTC offer失败返回error，不伪装无公网候选成功', async () => {
  vi.stubGlobal('RTCPeerConnection', Peer);
  vi.spyOn(Peer.prototype, 'createOffer').mockRejectedValue(new Error('blocked'));
  expect(await checkWebRtc()).toMatchObject({ supported: true, status: 'error' });
  expect(Peer.last.close).toHaveBeenCalledOnce();
});
it('WebRTC存在但构造失败显示检测器异常，不冒充环境不支持', async () => {
  vi.stubGlobal('RTCPeerConnection', class { constructor() { throw new Error('blocked'); } });
  expect(await checkWebRtc()).toMatchObject({ supported: true, status: 'error' });
});
it('WebRTC超时有独立状态并释放连接', async () => {
  vi.useFakeTimers(); vi.stubGlobal('RTCPeerConnection', Peer);
  const result = checkWebRtc(100); await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ status: 'timeout' }); expect(Peer.last.close).toHaveBeenCalledOnce();
});
it('只有ICE明确结束才报告complete，重复结束不会重复释放', async () => {
  vi.stubGlobal('RTCPeerConnection', Peer); const result = checkWebRtc();
  Peer.last.onicecandidate?.({ candidate: null }); Peer.last.onicecandidate?.({ candidate: null });
  expect(await result).toMatchObject({ status: 'complete' }); expect(Peer.last.close).toHaveBeenCalledOnce();
});

it('ICE状态已complete但未发送null候选时也能结束，不误报超时', async () => {
  vi.useFakeTimers(); vi.stubGlobal('RTCPeerConnection', Peer);
  const result = checkWebRtc(100);
  Peer.last.iceGatheringState = 'complete'; Peer.last.onicegatheringstatechange?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ status: 'complete' });
});

it('空candidate只是当前generation结束，未complete时不能提前通过', async () => {
  vi.useFakeTimers(); vi.stubGlobal('RTCPeerConnection', Peer);
  const result = checkWebRtc(100);
  Peer.last.onicecandidate?.({ candidate: { candidate: '' } });
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ status: 'timeout' });
});

it('只读取候选地址，排除raddr与私网，同时收集IPv6和公网host候选', async () => {
  vi.stubGlobal('RTCPeerConnection', Peer); const result = checkWebRtc();
  for (const candidate of [
    'candidate:1 1 udp 123 8.8.8.8 12345 typ srflx raddr 192.168.1.12 rport 12345',
    'candidate:2 1 udp 123 2606:4700:4700::1111 12345 typ srflx raddr :: rport 0',
    'candidate:3 1 udp 123 1.1.1.1 12345 typ host',
    'candidate:4 1 udp 123 192.168.1.12 12345 typ host',
  ]) Peer.last.onicecandidate?.({ candidate: { candidate } });
  Peer.last.onicecandidate?.({ candidate: null });
  expect((await result).publicIps.sort()).toEqual(['1.1.1.1', '2606:4700:4700::1111', '8.8.8.8']);
});

it('STUN错误保留原因，ICE完成也不能据此报告阻断已验证', async () => {
  vi.stubGlobal('RTCPeerConnection', Peer); const pending = checkWebRtc();
  Peer.last.onicecandidateerror?.({ errorCode: 701 });
  Peer.last.onicecandidate?.({ candidate: null });
  const result = await pending;
  expect(result).toMatchObject({ status: 'complete', stunError: 701 });
  expect(describeWebRtc(result, { tun: true, blockWebRtc: true }).status).toBe('info');
  expect(describeWebRtc(result, { tun: true, blockWebRtc: true }).text).toContain('STUN 无响应');
});

it('阻断配置下超时解释为未验证，TUN出口不冒充直连泄漏证据', () => {
  const timeout = describeWebRtc({ supported: true, status: 'timeout', publicIps: [] }, { tun: true, blockWebRtc: true });
  expect(timeout.status).toBe('info'); expect(timeout.text).toContain('阻断');
  const result = { supported: true, status: 'complete' as const, publicIps: ['8.8.8.8'] };
  expect(describeWebRtc(result, { direct: '8.8.8.8', proxied: '8.8.8.8', tun: true }).status).not.toBe('bad');
  expect(describeWebRtc(result, { direct: '8.8.8.8', proxied: '1.1.1.1', tun: false }).status).toBe('bad');
});
