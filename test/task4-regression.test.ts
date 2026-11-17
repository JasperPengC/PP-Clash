// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OverviewPage } from '../src/pages/Overview';
import { KernelPage } from '../src/pages/Kernel';
import App from '../src/App';
import { useApp } from '../src/store/app';
import { api } from '../src/core/api';
const listeners = vi.hoisted(() => new Map<string, (event: any) => void>());
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn().mockResolvedValue(undefined), listen: vi.fn(async (name, cb) => { listeners.set(name, cb); return () => listeners.delete(name); }) }));
vi.mock('../src/core/window-activity', () => ({ useWindowVisible: () => false }));
vi.mock('../src/application/background-health', () => ({ useBackgroundHealth: () => {} }));
vi.mock('../src/core/api', async original => {
 const actual = await original<any>();
 return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
 vi.useFakeTimers(); vi.clearAllMocks(); listeners.clear(); localStorage.clear();
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
 host=document.createElement('div'); document.body.append(host); root=createRoot(host);
 useApp.setState({ ...useApp.getInitialState(), kernelPhase:'running', configPath:'/isolated/config.yaml', dataDir:'/isolated', connectedAt:1,
 activeId:'p', profiles:[{id:'p',name:'fixture',url:'',raw:'proxies: []',userinfo:null,updatedAt:0,updateIntervalHours:null}],
 groups:[{name:'Main',type:'Selector',now:'A',nodes:[{name:'A',type:'Shadowsocks',delay:null}]}], routing:{primary:'Main',managed:['Main']},
 notify:vi.fn(), refreshGroups:vi.fn(async()=>true), applyConfig:vi.fn(async()=>true) });
 vi.mocked(api.startKernel).mockResolvedValue({running:true,pid:123});
 vi.mocked(api.setSystemProxy).mockImplementation(async on=>({enabled:on}));
 vi.mocked(api.kernelInfo).mockResolvedValue({running:true});
 vi.mocked(api.listKernelVersions).mockResolvedValue([]);
 vi.mocked(api.systemHelperInfo).mockResolvedValue({installed:false});
});
afterEach(async()=>{ await act(async()=>root.unmount()); host.remove(); vi.useRealTimers(); });
it('单节点测速途中隐藏再显示，完成后应解除测量中并允许重新测速',async()=>{
 let finish!: (v:number)=>void;
 useApp.setState({testDelay:vi.fn(()=>new Promise<number>(r=>finish=r))});
 const gauge=()=>host.querySelector<HTMLButtonElement>('[aria-label^="测速当前节点"]')!;
 await act(async()=>root.render(createElement(OverviewPage,{active:true})));
 await act(async()=>gauge().click());
 expect(finish).toBeTypeOf('function');
 await act(async()=>root.render(createElement(OverviewPage,{active:false})));
 await act(async()=>finish(80));
 await act(async()=>root.render(createElement(OverviewPage,{active:true})));
 expect(gauge().disabled).toBe(false);
 expect(gauge().textContent).not.toContain('测量中');
});
it.each(['127.0.0.1', '127.5.6.7', 'localhost', 'LOCALHOST.', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '[0:0:0:0:0:ffff:7f00:1]', '::ffff:127.255.255.255'])('回环监听地址%s不能启用局域网访问',async address=>{
 useApp.setState(s=>({settings:{...s.settings,authUser:'user',authPass:'pass',bindAddress:address}}));
 await act(async()=>root.render(createElement(KernelPage)));
 expect(host.querySelector<HTMLButtonElement>('[aria-label="允许局域网连接"]')!.disabled).toBe(true);
});
it('托盘切换模式等待配置时断开，不应由旧App续体重新启动',async()=>{
 let finish!: (v:boolean)=>void;
 useApp.setState({sysProxyEnabled:true,applyConfig:vi.fn().mockImplementationOnce(()=>new Promise(r=>finish=r)).mockResolvedValue(true)});
 await act(async()=>root.render(createElement(App)));
 await act(async()=>listeners.get('tray://mode')!({payload:'global'}));
 expect(finish).toBeTypeOf('function');
 await act(async()=>useApp.getState().disconnect());
 await act(async()=>finish(true));
 await act(async()=>vi.advanceTimersByTimeAsync(500));
 expect(api.startKernel).not.toHaveBeenCalled();
});


it.each([false, 'reject'])('托盘模式配置失败%s时不停止或重启内核', async result => {
 const applyConfig = result === false ? vi.fn(async () => false) : vi.fn(async () => { throw new Error('invalid configuration'); });
 const restartKernel = vi.fn(async () => true);
 useApp.setState({ applyConfig, restartKernel });
 await act(async () => root.render(createElement(App)));
 await act(async () => listeners.get('tray://mode')!({ payload: 'global' }));
 await act(async () => vi.advanceTimersByTimeAsync(500));
 expect(api.startKernel).not.toHaveBeenCalled();
 expect(api.stopKernel).not.toHaveBeenCalled();
 expect(restartKernel).not.toHaveBeenCalled();
});

it('单节点请求跨隐藏与连接变化仍占用原槽，完成后允许新请求且不会解除新请求的锁', async () => {
 const finish: Array<(delay: number) => void> = [];
 const testDelay = vi.fn(() => new Promise<number>(resolve => finish.push(resolve)));
 useApp.setState({ testDelay });
 const gauge = () => host.querySelector<HTMLButtonElement>('[aria-label^="测速当前节点"]')!;
 await act(async () => root.render(createElement(OverviewPage, { active: true })));
 await act(async () => gauge().click());
 await act(async () => root.render(createElement(OverviewPage, { active: false })));
 await act(async () => useApp.setState({ connectedAt: 2 }));
 await act(async () => root.render(createElement(OverviewPage, { active: true })));
 await act(async () => gauge().click());
 expect(testDelay).toHaveBeenCalledTimes(1);
 await act(async () => finish.shift()!(20));
 expect(gauge().disabled).toBe(false);
 await act(async () => gauge().click());
 expect(testDelay).toHaveBeenCalledTimes(2);
 expect(gauge().disabled).toBe(true);
 await act(async () => vi.advanceTimersByTimeAsync(10));
 expect(gauge().disabled).toBe(true);
 await act(async () => finish.shift()!(90));
 expect(gauge().disabled).toBe(false);
 expect(gauge().textContent).toContain('90');
});

it('隐藏后单节点测速等待旧整组请求释放槽位，峰值仍不超过3', async () => {
 let inFlight = 0; let peak = 0;
 const finish: Array<(delay: number) => void> = [];
 const testDelay = vi.fn(async () => {
   inFlight++; peak = Math.max(peak, inFlight);
   try { return await new Promise<number>(resolve => finish.push(resolve)); }
   finally { inFlight--; }
 });
 useApp.setState({ testDelay, groups: [{ name: 'Main', type: 'Selector', now: 'A', nodes: ['A','B','C','D','E'].map(name => ({name, type: 'Shadowsocks', delay: null})) }] });
 await act(async () => root.render(createElement(OverviewPage, { active: true })));
 await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="测速当前分组"]')!.click());
 expect(testDelay).toHaveBeenCalledTimes(3);
 await act(async () => root.render(createElement(OverviewPage, { active: false })));
 await act(async () => root.render(createElement(OverviewPage, { active: true })));
 await act(async () => host.querySelector<HTMLButtonElement>('[aria-label^="测速当前节点"]')!.click());
 expect(testDelay).toHaveBeenCalledTimes(3);
 await act(async () => finish.shift()!(40));
 expect(testDelay).toHaveBeenCalledTimes(4);
 await act(async () => finish.splice(0).forEach(resolve => resolve(80)));
 expect(peak).toBe(3);
 expect(inFlight).toBe(0);
 expect(testDelay).toHaveBeenCalledTimes(4);
});

it.each(['0.0.0.0', '::', '[::]', '*', '192.168.1.20', 'fd00::20', '::ffff:192.168.1.20'])('非回环监听%s具备认证时可开启局域网访问', async address => {
 useApp.setState(state => ({ settings: { ...state.settings, authUser: 'user', authPass: 'pass', bindAddress: address } }));
 await act(async () => root.render(createElement(KernelPage)));
 expect(host.querySelector<HTMLButtonElement>('[aria-label="允许局域网连接"]')!.disabled).toBe(false);
});
