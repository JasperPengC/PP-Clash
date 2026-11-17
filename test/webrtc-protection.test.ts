import { describe, expect, it, vi, afterEach } from 'vitest';
import { assessWebRtcProtection, checkWebRtcProtection } from '../src/core/webrtc-protection';
import { api } from '../src/core/api';

const config = { mode: 'rule', tun: { enable: true, 'auto-route': true, 'strict-route': true } };
const guardRules = [
  { type: 'DomainKeyword', payload: 'stun', proxy: 'REJECT-DROP' },
  { type: 'DstPort', payload: '3478-3479', proxy: 'REJECT-DROP' },
  { type: 'DstPort', payload: '5349-5350', proxy: 'REJECT-DROP' },
  { type: 'DstPort', payload: '19302-19309', proxy: 'REJECT-DROP' },
  { type: 'DomainSuffix', payload: 'turn.twilio.com', proxy: 'REJECT-DROP' },
];
const assess = (rules = guardRules, cfg: unknown = config) => assessWebRtcProtection(cfg, { rules });
afterEach(() => vi.restoreAllMocks());

describe('只读运行规则核验', () => {
  it('接受实际内核大小写形式，跳过不匹配的固定出口域名规则', () => {
    const result = assess([{ type: 'DomainSuffix', payload: 'github.com', proxy: 'GitHub 固定出口' }, ...guardRules]);
    expect(result).toMatchObject({ status: 'ok', verified: true });
    expect(result.text).toContain('规则已核验');
    expect(assess(guardRules.map(r => ({ ...r, type: r.type === 'DstPort' ? 'DST-PORT' : r.type })))).toMatchObject({ verified: true });
  });
  it.each(['global', 'direct'])('%s 模式绕过规则，不能因规则存在就通过', mode => {
    expect(assess(guardRules, { ...config, mode })).toMatchObject({ status: 'warn', verified: false });
  });
  it.each([
    { enable: false, 'auto-route': true, 'strict-route': true },
    { enable: true, 'auto-route': false, 'strict-route': true },
    { enable: true, 'auto-route': true, 'strict-route': false },
  ])('没有完整 TUN 接管不能声称浏览器 UDP 受保护：%j', tun => {
    expect(assess(guardRules, { ...config, tun }).verified).toBe(false);
  });
  it.each([
    { type: 'Match', payload: '', proxy: 'DIRECT' },
    { type: 'DomainSuffix', payload: 'google.com', proxy: '代理' },
    { type: 'DstPort', payload: '19302', proxy: 'DIRECT' },
    { type: 'Network', payload: 'udp', proxy: 'DIRECT' },
  ])('前置放行规则覆盖测试目标时不通过：%j', prior => {
    expect(assess([prior, ...guardRules])).toMatchObject({ status: 'warn', verified: false });
  });
  it('未知规则集在阻断前时保守返回未核验；阻断后的规则不影响结果', () => {
    const unknown = { type: 'RuleSet', payload: 'custom', proxy: 'DIRECT' };
    expect(assess([unknown, ...guardRules])).toMatchObject({ status: 'info', verified: false });
    expect(assess([...guardRules, unknown])).toMatchObject({ status: 'ok', verified: true });
  });
  it('缺少常用端口规则、错误动作、空响应均不能核验通过', () => {
    expect(assess(guardRules.filter(r => r.payload !== '3478-3479')).verified).toBe(false);
    expect(assess(guardRules.map(r => ({ ...r, proxy: 'DIRECT' }))).verified).toBe(false);
    expect(assessWebRtcProtection(null, null).verified).toBe(false);
  });
  it('控制器失败与异常格式独立展示，核验只发送 GET', async () => {
    const request = vi.spyOn(api, 'mihomo').mockImplementation(async (_method, path) => path === '/configs' ? config : { rules: guardRules });
    expect(await checkWebRtcProtection()).toMatchObject({ verified: true });
    expect(request.mock.calls).toEqual([['GET', '/configs'], ['GET', '/rules']]);
    request.mockRejectedValue(new Error('private-controller-secret'));
    expect(await checkWebRtcProtection()).toMatchObject({ status: 'info', verified: false });
    expect((await checkWebRtcProtection()).text).not.toContain('private-controller-secret');
  });
});
