// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return {...actual,isTauri:true,api:Object.fromEntries(Object.keys(actual.api).map(key=>[key,vi.fn().mockResolvedValue(undefined)]))};
});
const raw='proxies: [{name: A, type: ss}]\nproxy-groups: [{name: 先自动, type: url-test, proxies: [A]}, {name: 后手动, type: select, proxies: [A]}]\nproxy-providers: {远程: {type: http}}';
beforeEach(()=>{
  vi.clearAllMocks(); useApp.setState({...useApp.getInitialState(),activeId:'p',runtimeConfigRevision:7,connectedAt:1,kernelPhase:'running',
    profiles:[{id:'p',name:'P',raw,url:'',updatedAt:0,userinfo:null,updateIntervalHours:null}],routing:{primary:'后手动',managed:['后手动']}});
});
it('刷新保留订阅顺序，未知组类型不消失，provider 元数据与当前会话绑定',async()=>{
  vi.mocked(api.mihomo).mockImplementation(async(_method,path)=>path==='/providers/proxies'
    ? {providers:{远程:{updatedAt:'2026-11-10',proxies:[{name:'A',type:'Shadowsocks'}]}}}
    : {proxies:{后手动:{type:'Selector',now:'A',all:['A']},先自动:{type:'URLTest',now:'A',all:['A']},未来策略:{type:'FutureStrategy',all:['A']},A:{type:'Shadowsocks'}}});
  expect(await useApp.getState().refreshGroups()).toBe(true);
  expect(useApp.getState().groups.map(group=>group.name)).toEqual(['先自动','后手动','未来策略']);
  expect(useApp.getState().proxyRuntime).toMatchObject({profileId:'p',revision:7,connectedAt:1,providers:{providers:{远程:{updatedAt:'2026-11-10'}}}});
});
it('源读取失败保留同一会话缓存，但换配置不串用旧来源',async()=>{
  let failure=false;
  vi.mocked(api.mihomo).mockImplementation(async(_method,path)=>{
    if(path==='/providers/proxies') {if(failure)throw new Error('离线');return {providers:{远程:{proxies:[{name:'A',type:'Shadowsocks'}]}}};}
    return {proxies:{后手动:{type:'Selector',now:'A',all:['A']},A:{type:'Shadowsocks'}}};
  });
  await useApp.getState().refreshGroups(); await useApp.getState().refreshProxyProviders(); failure=true;
  await useApp.getState().refreshProxyProviders(true);
  expect(useApp.getState().proxyRuntime?.providersError).toContain('离线');
  expect(useApp.getState().proxyRuntime?.providers).toMatchObject({providers:{远程:{proxies:[{name:'A'}]}}});
  useApp.setState({runtimeConfigRevision:8}); await useApp.getState().refreshGroups();
  expect(useApp.getState().proxyRuntime?.providers).toBeUndefined();
});

const proxyResponse = {proxies:{后手动:{type:'Selector',now:'A',all:['A']},A:{type:'Shadowsocks'}}};
it('provider请求挂起时节点确认立即完成，重复节点刷新不会重复读取来源',async()=>{
  let finish!: (value:unknown)=>void;
  vi.mocked(api.mihomo).mockImplementation(async(_method,path)=>path==='/providers/proxies'
    ? new Promise(resolve=>{finish=resolve;}) : proxyResponse);
  let completed=false;
  const refresh=useApp.getState().refreshGroups().then(value=>{completed=value;});
  for(let i=0;i<12;i++)await Promise.resolve();
  expect(completed).toBe(true);expect(useApp.getState().groups[0].name).toBe('后手动');
  await refresh;await useApp.getState().refreshGroups();
  expect(vi.mocked(api.mihomo).mock.calls.filter(([,path])=>path==='/providers/proxies')).toHaveLength(1);
  finish({providers:{远程:{proxies:[]}}});
  for(let i=0;i<12;i++)await Promise.resolve();
  await useApp.getState().refreshGroups();
  expect(vi.mocked(api.mihomo).mock.calls.filter(([,path])=>path==='/providers/proxies')).toHaveLength(1);
});
it('无provider配置的节点确认不发送来源请求',async()=>{
  useApp.setState(state=>({profiles:state.profiles.map(profile=>({...profile,raw:'proxies: [{name: A, type: ss}]'}))}));
  vi.mocked(api.mihomo).mockResolvedValue(proxyResponse);
  await useApp.getState().refreshGroups();
  expect(vi.mocked(api.mihomo).mock.calls.map(([,path])=>path)).toEqual(['/proxies']);
});
it('只有有序分组名称变化才同步托盘，不随每次节点刷新重复发送',async()=>{
  vi.mocked(api.mihomo).mockResolvedValue(proxyResponse);
  await useApp.getState().refreshGroups();
  expect(vi.mocked(api.setTrayFlags).mock.calls.at(-1)?.[8]).toEqual(['后手动']);
  vi.mocked(api.setTrayFlags).mockClear();
  await useApp.getState().refreshGroups();
  expect(api.setTrayFlags).not.toHaveBeenCalled();
});
it.each(['revision','transition','connection'] as const)('节点读取跨%s失效，不能发布过期groups',async kind=>{
  let finish!: (value:unknown)=>void;
  vi.mocked(api.mihomo).mockImplementation(async(_method,path)=>path==='/proxies'?new Promise(resolve=>{finish=resolve;}):{providers:{}});
  const refresh=useApp.getState().refreshGroups();
  useApp.setState(kind==='revision'?{runtimeConfigRevision:8}:kind==='transition'?{runtimeConfigTransition:true}:{connectedAt:2});
  finish(proxyResponse);
  expect(await refresh).toBe(false);expect(useApp.getState().groups).toEqual([]);expect(useApp.getState().proxyRuntime).toBeNull();
});
it.each(['revision','transition','connection'] as const)('来源读取跨%s失效，不能回写旧元数据',async kind=>{
  let finish!: (value:unknown)=>void;
  vi.mocked(api.mihomo).mockImplementation(async(_method,path)=>path==='/providers/proxies'?new Promise(resolve=>{finish=resolve;}):proxyResponse);
  const refresh=useApp.getState().refreshGroups();
  for(let i=0;i<12;i++)await Promise.resolve();
  useApp.setState(kind==='revision'?{runtimeConfigRevision:8}:kind==='transition'?{runtimeConfigTransition:true}:{connectedAt:2});
  finish({providers:{远程:{proxies:[{name:'旧元数据',type:'Shadowsocks'}]}}});
  await refresh;for(let i=0;i<12;i++)await Promise.resolve();
  expect(useApp.getState().proxyRuntime?.providers).toBeUndefined();
  expect(useApp.getState().groups.some(group=>group.nodes.some(node=>node.name==='旧元数据'))).toBe(false);
});

it('来源重复刷新复用在途请求，失败不被节点轮询重复重试，显式刷新能恢复',async()=>{
  let finish!: (value:unknown)=>void;let reject!: (reason:unknown)=>void;
  vi.mocked(api.mihomo).mockImplementation(async(_method,path)=>path==='/providers/proxies'?new Promise((resolve,fail)=>{finish=resolve;reject=fail;}):proxyResponse);
  await useApp.getState().refreshGroups();
  const pending=useApp.getState().refreshProxyProviders(true);
  const duplicate=useApp.getState().refreshProxyProviders(true);
  expect(pending).toBe(duplicate);
  reject(new Error('读取失败'));expect(await pending).toBe(false);
  await useApp.getState().refreshGroups();
  expect(vi.mocked(api.mihomo).mock.calls.filter(([,path])=>path==='/providers/proxies')).toHaveLength(1);
  const recovery=useApp.getState().refreshProxyProviders(true);
  finish({providers:{远程:{proxies:[{name:'A',type:'Shadowsocks'}]}}});
  expect(await recovery).toBe(true);expect(useApp.getState().proxyRuntime?.providersError).toBeUndefined();
});
it('过渡状态快速开关也使旧来源请求失效，新会话可以重新读取一次',async()=>{
  const finishes:Array<(value:unknown)=>void>=[];
  vi.mocked(api.mihomo).mockImplementation(async(_method,path)=>path==='/providers/proxies'?new Promise(resolve=>finishes.push(resolve)):proxyResponse);
  await useApp.getState().refreshGroups();
  const old=useApp.getState().refreshProxyProviders();
  useApp.setState({runtimeConfigTransition:true});useApp.setState({runtimeConfigTransition:false});
  await useApp.getState().refreshGroups();
  expect(finishes).toHaveLength(2);
  finishes[0]({providers:{远程:{proxies:[{name:'旧',type:'Shadowsocks'}]}}});expect(await old).toBe(false);
  expect(useApp.getState().proxyRuntime?.providers).toBeUndefined();
  const next=useApp.getState().refreshProxyProviders();
  finishes[1]({providers:{远程:{proxies:[{name:'新',type:'Shadowsocks'}]}}});expect(await next).toBe(true);
  expect(useApp.getState().proxyRuntime?.providers).toMatchObject({providers:{远程:{proxies:[{name:'新'}]}}});
});
it('来源请求挂起不阻塞固定选择的内核确认与保存',async()=>{
  let finish!: (value:unknown)=>void;
  vi.mocked(api.mihomo).mockImplementation(async(method,path)=>path==='/providers/proxies'?new Promise(resolve=>{finish=resolve;}):method==='PUT'?undefined:proxyResponse);
  await useApp.getState().refreshGroups();
  expect(await useApp.getState().toggleFixedNode('后手动','A')).toBe(true);
  expect(useApp.getState().fixedNodes.p?.后手动).toBe('A');
  expect(vi.mocked(api.mihomo).mock.calls.filter(([,path])=>path==='/providers/proxies')).toHaveLength(1);
  const source=useApp.getState().refreshProxyProviders();finish({providers:{}});await source;
});
