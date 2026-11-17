import { describe, expect, it } from 'vitest';
import { buildProxyDomain, resolveProxyRoute, type ProxyDomainInput } from '../src/core/proxy-domain';

const raw = `
proxies:
  - {name: 落地, type: socks5, dialer-proxy: 前置策略}
  - {name: 香港, type: ss}
  - {name: 备用, type: ss}
proxy-groups:
  - {name: 视频, type: select, proxies: [自动]}
  - {name: 自动, type: url-test, proxies: [落地]}
  - {name: 前置策略, type: select, proxies: [香港, 备用]}
`;
const groups = [
  {name: '前置策略', type: 'Selector', now: '香港', nodes: [{name: '香港', type: 'Shadowsocks', delay: 22}, {name: '备用', type: 'Shadowsocks', delay: 31}]},
  {name: '自动', type: 'URLTest', now: '落地', nodes: [{name: '落地', type: 'Socks5', delay: 35}]},
  {name: '视频', type: 'Selector', now: '自动', nodes: [{name: '自动', type: 'URLTest', delay: null}]},
];
const input: ProxyDomainInput = { raw, groups, profileId: 'a', revision: 1, runtime: true };

describe('真实代理域', () => {
  it('保留配置分组名称和顺序，不按节点数或策略类型重排', () => {
    expect(buildProxyDomain(input).groups.map(g => g.name)).toEqual(['视频', '自动', '前置策略']);
  });
  it('将选择关系与 dialer 转发顺序分开，原订阅字段只作为配置推断', () => {
    const route = resolveProxyRoute(buildProxyDomain(input), '视频');
    expect(route.selection).toEqual(['视频', '自动', '落地']);
    expect(route.forwarding).toEqual(['本机', '香港', '落地']);
    expect(route.certainty).toBe('configuration');
    expect(route.issues.some(issue => issue.code === 'unconfirmed-config')).toBe(true);
    expect(route.terminal).toBe('落地');
  });
  it('运行快照的 dialer 优先于订阅字段，但不将缺失字段解释为已确认直连', () => {
    const domain = buildProxyDomain({...input, runtimeProxies: { 落地: {type: 'Socks5', 'dialer-proxy': '备用'} }});
    expect(resolveProxyRoute(domain, '视频').forwarding).toEqual(['本机', '备用', '落地']);
    expect(resolveProxyRoute(domain, '视频').certainty).toBe('configuration');
  });
  it('负载均衡不接受 now 为唯一出口，过期选择不回退首成员', () => {
    const domain = buildProxyDomain({...input, groups: [
      {name: '均衡', type: 'LoadBalance', now: '香港', nodes: groups[0].nodes},
      {name: '过期', type: 'Selector', now: '旧节点', nodes: groups[0].nodes},
    ]});
    expect(resolveProxyRoute(domain, '均衡')).toMatchObject({kind: 'multiple', terminal: null, candidates: ['香港', '备用']});
    expect(resolveProxyRoute(domain, '过期').issues[0]).toMatchObject({code: 'stale-selection', at: '过期'});
    expect(resolveProxyRoute(domain, '过期').terminal).toBeNull();
  });
  it('配置预览的 use 与 include-all 显示等待源，加载后来源可追溯', () => {
    const providerRaw = `proxies: [{name: 本地, type: ss}]
proxy-providers:
  机场源: {type: http, url: https://example.invalid}
proxy-groups:
  - {name: 动态, type: select, use: [机场源]}
  - {name: 全部, type: select, include-all: true}`;
    const pending = buildProxyDomain({raw: providerRaw, profileId: 'p', revision: 1, runtime: false});
    expect(pending.groups[0].providers).toEqual([expect.objectContaining({name: '机场源', state: 'waiting'})]);
    expect(pending.groups[1].nodes.map(n=>n.name)).toEqual(['本地']);
    const loaded = buildProxyDomain({raw: providerRaw, profileId: 'p', revision: 1, runtime: false,
      providers: { providers: { 机场源: { proxies: [{name: '源节点', type: 'Shadowsocks'}], updatedAt: '2026-11-10T01:00:00Z' } } }});
    expect(loaded.groups[0].nodes.map(n=>n.name)).toEqual(['源节点']);
    expect(loaded.objects.get('源节点')?.providers).toEqual(['机场源']);
    expect(loaded.groups[0].providers[0]).toMatchObject({state: 'loaded', updatedAt: '2026-11-10T01:00:00Z'});
    const failed = buildProxyDomain({raw: providerRaw, profileId: 'p', revision: 1, runtime: false, providersError:'读取失败'});
    expect(failed.groups[0].providers[0].state).toBe('error');
  });
  it('没有分组的自建节点仍可见，合成浏览分组不可当成内核策略', () => {
    const domain = buildProxyDomain({raw: 'proxies: [{name: 独立, type: ss}]', profileId: 'p', revision: 1, runtime: true,
      runtimeProxies: { 独立: {type: 'Shadowsocks'}, DIRECT: {type: 'Direct'} }});
    expect(domain.groups[0]).toMatchObject({synthetic: true, now: '', nodes: [expect.objectContaining({name:'独立'})]});
  });
  it('旧 Relay 保留原成员顺序并声明能力未验证', () => {
    const domain = buildProxyDomain({raw:'proxy-groups: [{name: 旧链路, type: relay, proxies: [香港, 落地]}]', profileId:'p', revision:1,
      runtime: false});
    const route=resolveProxyRoute(domain, '旧链路');
    expect(route.forwarding).toEqual(['本机','香港','落地']);
    expect(route.issues.some(i=>i.code==='relay-unverified')).toBe(true);
    expect(route.terminal).toBeNull();
  });
  it('循环、缺失引用、深路径均有界并指出对象，不误报直连或阻断', () => {
    const cycle=buildProxyDomain({raw:'proxies: [{name: A, type: ss, dialer-proxy: B}, {name: B, type: ss, dialer-proxy: A}]', profileId:'p',revision:1,runtime:false});
    expect(resolveProxyRoute(cycle,'A').issues.some(i=>i.code==='cycle'&&i.at==='A')).toBe(true);
    expect(resolveProxyRoute(cycle,'不存在')).toMatchObject({kind:'unknown',terminal:null});
    expect(resolveProxyRoute(cycle,'DIRECT').kind).toBe('direct');
    expect(resolveProxyRoute(cycle,'REJECT').kind).toBe('reject');
    const deep=buildProxyDomain({raw:'',profileId:'p',revision:1,runtime:true,groups:Array.from({length:40},(_,i)=>({name:`G${i}`,type:'Selector',now:`G${i+1}`,nodes:[{name:`G${i+1}`,type:'Selector',delay:null}]}))});
    const path=resolveProxyRoute(deep,'G0');
    expect(path.selection.length).toBeLessThanOrEqual(17);
    expect(path.issues.some(i=>i.code==='depth-limit')).toBe(true);
  });
  it('订阅与配置版本隔离展示身份；预览不编造自动组当前选择', () => {
    expect(buildProxyDomain(input).identity).not.toBe(buildProxyDomain({...input,profileId:'b'}).identity);
    expect(buildProxyDomain(input).identity).not.toBe(buildProxyDomain({...input,revision:2}).identity);
    expect(resolveProxyRoute(buildProxyDomain({...input,groups:[],runtime:false}),'视频').terminal).toBeNull();
  });
});

it('缺失的下级策略不能伪装为终端节点，运行期无组浏览不混入被覆写移除的订阅节点', () => {
  const missing=buildProxyDomain({raw:'',profileId:'p',revision:1,runtime:true,
    groups:[{name:'入口',type:'Selector',now:'消失的组',nodes:[{name:'消失的组',type:'Selector',delay:null}]}]});
  expect(resolveProxyRoute(missing,'入口')).toMatchObject({kind:'unknown',terminal:null});
  expect(resolveProxyRoute(missing,'入口').issues.some(issue=>issue.code==='missing')).toBe(true);
  const observed=buildProxyDomain({raw:'proxies: [{name: 旧节点, type: ss}]',profileId:'p',revision:1,runtime:true,
    runtimeProxies:{新节点:{type:'Shadowsocks'}}});
  expect(observed.groups[0].nodes.map(node=>node.name)).toEqual(['新节点']);
});

it('前置 DIRECT 不伪造成代理跳点，前置阻断终止路径，PASS 不声称唯一出口', () => {
  const domain=buildProxyDomain({raw:'proxies: [{name: A, type: ss, dialer-proxy: DIRECT}, {name: B, type: ss, dialer-proxy: REJECT}]',profileId:'p',revision:1,runtime:false});
  expect(resolveProxyRoute(domain,'A').forwarding).toEqual(['本机','A']);
  expect(resolveProxyRoute(domain,'B')).toMatchObject({kind:'reject',terminal:'REJECT',forwarding:['本机','REJECT']});
  expect(resolveProxyRoute(domain,'PASS')).toMatchObject({kind:'unknown',terminal:null});
});

it('只有运行节点名称和协议时保留当前选择，但不凭空补出单跳转发链路', () => {
  const domain=buildProxyDomain({raw:'',profileId:'p',revision:1,runtime:true,groups:[{name:'入口',type:'Selector',now:'A',nodes:[{name:'A',type:'Shadowsocks',delay:25}]}]});
  const route=resolveProxyRoute(domain,'入口');
  expect(route.selection).toEqual(['入口','A']);expect(route.terminal).toBe('A');
  expect(route.forwarding).toEqual([]);expect(route.certainty).toBe('unknown');
});

it('已确认运行空分组不回退被覆写移除的订阅策略', () => {
  const domain=buildProxyDomain({raw:'proxies: [{name: Old, type: ss}]\nproxy-groups: [{name: Removed, type: select, proxies: [Old]}]',
    profileId:'p',revision:1,runtime:true,groups:[],runtimeProxies:{New:{type:'Shadowsocks'}}});
  expect(domain.groups.map(group=>group.name)).toEqual(['全部节点']);
  expect(domain.groups[0]).toMatchObject({synthetic:true,type:'Browse',nodes:[{name:'New',type:'Shadowsocks',delay:null}]});
  const empty=buildProxyDomain({raw:'proxy-groups: [{name: Removed, type: select, proxies: [Old]}]',profileId:'p',revision:1,runtime:true,groups:[],runtimeProxies:{}});
  expect(empty.groups).toEqual([]);
});

it.each(['Relay','LoadBalance'])('前置%s不覆盖已观测的落地选择，也不把前置片段冒充完整转发链路', type=>{
  const domain=buildProxyDomain({raw:'proxies: [{name: Landing, type: socks5, dialer-proxy: Front}, {name: A, type: ss}, {name: B, type: ss}]',
    profileId:'p',revision:1,runtime:true,groups:[
      {name:'Entry',type:'Selector',now:'Landing',nodes:[{name:'Landing',type:'Socks5',delay:null}]},
      {name:'Front',type,now:'A',nodes:[{name:'A',type:'Shadowsocks',delay:null},{name:'B',type:'Shadowsocks',delay:null}]},
    ]});
  const route=resolveProxyRoute(domain,'Entry');
  expect(route).toMatchObject({kind:'selected',selection:['Entry','Landing'],terminal:'Landing',forwarding:[],candidates:[],certainty:'unknown'});
  expect(route.issues.some(issue=>issue.at==='Front'&&issue.message.includes('前置'))).toBe(true);
});
