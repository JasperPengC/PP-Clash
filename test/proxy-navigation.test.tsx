// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProxiesPage, visibleGroupTabs, orderedGroupNodes } from '../src/pages/Proxies';
import { useApp } from '../src/store/app';
import { api } from '../src/core/api';
import { DEFAULT_LATENCY_URL } from '../src/core/latency';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});
const initial = useApp.getInitialState();
let host: HTMLDivElement;
let root: Root;
const rows = () => [...host.querySelectorAll<HTMLElement>('.proxy-node')];
const button = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const click = async (label: string) => act(async () => button(label).click());
const render = async (active = true) => act(async () => root.render(createElement(ProxiesPage, { active })));
const setQuery = async (query: string) => act(async () => {
  const input = host.querySelector<HTMLInputElement>('[aria-label="搜索节点"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const seed = (count: number) => useApp.setState({ groups: [{ name: '线路', type: 'Selector', now: `线路 ${count - 1}`,
  nodes: Array.from({ length: count }, (_, i) => ({ name: `线路 ${i}`, type: 'Shadowsocks', delay: null,
    delaysByTarget: { [DEFAULT_LATENCY_URL]: count - i } })) }] });

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('ppclash.proxy.groups.open', JSON.stringify({ 线路: true }));
  useApp.setState({ ...initial, activeId: 'fixture', connectedAt: 1, kernelPhase: 'running', notify: vi.fn(),
    profiles: [{ id: 'fixture', name: '测试订阅', url: '', raw: '', updatedAt: 0, userinfo: null, updateIntervalHours: null }] });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it.each([100, 500, 2000])('%i 节点连续滚动保持60项预算，末尾与当前节点可达', async count => {
  seed(count); await render();
  expect(rows()).toHaveLength(60);
  expect(rows()[0].querySelector('.proxy-node-select')?.getAttribute('title')).toBe(`线路 ${count - 1}`);
  expect(host.querySelector('.proxy-pagination')).toBeNull();
  expect(host.querySelector('[aria-label$="下一页"]')).toBeNull();
  const viewport = host.querySelector<HTMLElement>('[aria-label="线路 节点"]')!;
  await act(async () => { viewport.scrollTop = 1_000_000; viewport.dispatchEvent(new Event('scroll')); });
  expect(rows().some(row => row.querySelector('.proxy-node-select')?.getAttribute('title') === '线路 0')).toBe(true);
  expect(rows().length).toBeLessThanOrEqual(60);
  await act(async () => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(document.activeElement?.getAttribute('title')).toBe(`线路 ${count - 1}`);
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(document.activeElement?.getAttribute('title')).toBe('线路 0');
  expect(rows().length).toBeLessThanOrEqual(60);
  await click('线路 定位当前节点');
  expect(rows()[0].querySelector('.proxy-node-select')?.getAttribute('title')).toBe(`线路 ${count - 1}`);
  expect(rows().length).toBeLessThanOrEqual(60);
  expect(document.activeElement?.classList.contains('selected')).toBe(true);
  await setQuery('线路 0');
  expect(rows()).toHaveLength(1);
  expect(rows()[0].querySelector('.proxy-node-select')?.getAttribute('title')).toBe('线路 0');
});

it('搜索和延迟排序作用全组，小组不出现分页', async () => {
  seed(500); await render();
  await setQuery('线路 499');
  expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain('线路 499');
  expect(host.querySelector('.proxy-pagination')).toBeNull();
  await click('清空搜索');
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.seg-btn')].find(el => el.textContent === '延迟')!.click());
  expect(rows()[0].textContent).toContain('线路 499');
  await act(async () => seed(8));
  expect(rows()).toHaveLength(8); expect(host.querySelector('.proxy-pagination')).toBeNull();
});

it('节点搜索限定浏览组，全部分组选择器可查找其他组成员', async () => {
  seed(100);
  useApp.setState(state=>({groups:[...state.groups,{name:'另一组',type:'Selector',now:'唯一节点',nodes:[{name:'唯一节点',type:'Shadowsocks',delay:null}]}]}));
  await render(); await click('查看分组 另一组'); expect(rows()[0].textContent).toContain('唯一节点');
  await setQuery('线路 99'); expect(rows()).toHaveLength(0);expect(host.textContent).toContain('没有符合筛选条件的节点');
  await click('清空搜索'); expect(rows()).toHaveLength(1);expect(rows()[0].textContent).toContain('唯一节点');
  await click('全部分组 2');
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="搜索全部分组"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '线路 99');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('线路');
  expect(document.querySelectorAll('.proxy-group-option')).toHaveLength(1);
  await act(async () => document.querySelector<HTMLButtonElement>('.proxy-group-option')!.click());
  expect(rows()[0].textContent).toContain('线路 99');
});

it('36组顶部有界且当前组始终第一，全部分组按原序展示并仅改变浏览上下文', async () => {
  const select = vi.fn(); const test = vi.fn();
  useApp.setState({ selectNode: select, testDelay: test, groups: Array.from({ length: 36 }, (_, i) => ({
    name: `group-${i}`, type: i === 35 ? 'URLTest' : 'Selector', now: `member-${i}`,
    nodes: [{ name: `member-${i}`, type: 'Shadowsocks', delay: null }],
  })) });
  await render();
  expect(host.querySelectorAll('.proxy-group-nav').length).toBeLessThanOrEqual(4);
  await click('全部分组 36');
  const options = [...document.querySelectorAll<HTMLButtonElement>('.proxy-group-option')];
  expect(options).toHaveLength(36);
  expect(options[0].textContent).toContain('group-0');
  expect(options[35].textContent).toContain('group-35');
  expect(options[35].textContent).toContain('自动测速');
  expect(options[35].textContent).toContain('member-35');
  expect(options[35].textContent).toContain('1 个成员');
  await act(async () => options[35].click());
  expect(host.querySelector('.proxy-group-nav')?.getAttribute('aria-label')).toBe('查看分组 group-35');
  expect(rows()[0].textContent).toContain('member-35');
  expect(select).not.toHaveBeenCalled(); expect(test).not.toHaveBeenCalled();
  await click('全部分组 36');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('分组视图助手去重最近项且固定当前首位，不改变原始顺序', () => {
  const groups = Array.from({ length: 36 }, (_, i) => ({ name: `group-${i}` }));
  expect(visibleGroupTabs(groups, 'group-35', ['group-12', 'missing', 'group-12', 'group-9'], 4).map(group => group.name))
    .toEqual(['group-35', 'group-12', 'group-9', 'group-0']);
  expect(groups[0].name).toBe('group-0');
});

it('节点视图助手当前第一，其余延迟升序，未测和失败置后且筛选不会修改数据', () => {
  const nodes = [
    { name: 'unmeasured', type: 'Shadowsocks', delay: undefined },
    { name: 'failed', type: 'Shadowsocks', delay: null },
    { name: 'selected', type: 'Shadowsocks', delay: 300 },
    { name: 'slow', type: 'Shadowsocks', delay: 90 },
    { name: 'fast', type: 'Shadowsocks', delay: 20 },
    { name: 'zero', type: 'Shadowsocks', delay: 0 },
  ];
  expect(orderedGroupNodes(nodes, 'selected', 'delay', 'all').map(node => node.name))
    .toEqual(['selected', 'fast', 'slow', 'unmeasured', 'failed', 'zero']);
  expect(orderedGroupNodes(nodes, 'selected', 'default', 'all').map(node => node.name))
    .toEqual(['selected', 'fast', 'slow', 'unmeasured', 'failed', 'zero']);
  expect(orderedGroupNodes(nodes, 'selected', 'name', 'all').map(node => node.name))
    .toEqual(['selected', 'failed', 'fast', 'slow', 'unmeasured', 'zero']);
  expect(orderedGroupNodes(nodes, 'selected', 'delay', 'available').map(node => node.name))
    .toEqual(['selected', 'fast', 'slow', 'unmeasured']);
  expect(nodes[0].name).toBe('unmeasured');
});

it('浏览分组与节点主选择是独立按钮，固定不会触发主选择', async () => {
  seed(3);
  const select = vi.fn().mockResolvedValue(true);
  const fix = vi.fn().mockResolvedValue(true);
  useApp.setState({ selectNode: select, toggleFixedNode: fix });
  await render();
  const disclosure = host.querySelector<HTMLButtonElement>('button.proxy-group-nav')!;
  expect(disclosure).not.toBeNull();
  expect(disclosure.getAttribute('aria-current')).toBe('true');
  expect(disclosure.querySelector('button')).toBeNull();
  const choose = rows().find(row => row.querySelector('.proxy-node-select')?.getAttribute('title') === '线路 0')!.querySelector<HTMLButtonElement>('button.proxy-node-select')!;
  expect(choose).not.toBeNull();
  expect(choose.getAttribute('aria-pressed')).toBe('false');
  await act(async () => choose.click());
  expect(select).toHaveBeenCalledWith('线路', '线路 0');
  await click('固定使用 线路 0');
  expect(select).toHaveBeenCalledTimes(1);
  expect(fix).toHaveBeenCalledWith('线路', '线路 0');
  await act(async () => disclosure.click());
  expect(rows()).toHaveLength(3);
  expect(select).toHaveBeenCalledTimes(1);
});

it('定位当前可清除排除当前节点的筛选并保留完整名称', async () => {
  seed(100); await render();
  await setQuery('线路 0');
  await click('线路 定位当前节点');
  expect(host.querySelector<HTMLInputElement>('[aria-label="搜索节点"]')!.value).toBe('');
  expect(rows().find(row => row.classList.contains('selected'))?.textContent).toContain('线路 99');
});

it('整组测速覆盖完整筛选结果，进度可取消并拒绝迟到结果', async () => {
  seed(100); vi.useFakeTimers();
  const pending: Array<() => void> = [];
  vi.mocked(api.mihomo).mockImplementation(async () => new Promise(resolve => pending.push(() => resolve({ delay: 777 }))));
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('.proxy-group-actions button')!.click());
  expect(api.mihomo).toHaveBeenCalledTimes(3);
  expect(host.querySelector('[role="status"]')?.textContent).toContain('0 / 100');
  await act(async () => { pending.splice(0).forEach(finish => finish()); });
  expect(api.mihomo).toHaveBeenCalledTimes(6);
  expect(rows()[0].textContent).not.toContain('777 ms');
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(host.querySelector('[role="status"]')?.textContent).toContain('3 / 100');
  expect(rows()[0].textContent).toContain('777 ms');
  await click('取消测速');
  await act(async () => { pending.splice(0).forEach(finish => finish()); });
  expect(api.mihomo).toHaveBeenCalledTimes(6);
  expect(rows()[3].textContent).not.toContain('777 ms');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('已取消');
});

it.each(['隐藏', '换订阅', '重连'] as const)('%s使测速失效，停止派发并拒绝旧结果', async change => {
  seed(100);
  const pending: Array<() => void> = [];
  vi.mocked(api.mihomo).mockImplementation(async () => new Promise(resolve => pending.push(() => resolve({ delay: 777 }))));
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('.proxy-group-actions button')!.click());
  if (change === '隐藏') await render(false);
  else await act(async () => useApp.setState(change === '换订阅' ? { activeId: 'new' } : { connectedAt: 2 }));
  await act(async () => { pending.splice(0).forEach(finish => finish()); });
  expect(api.mihomo).toHaveBeenCalledTimes(3);
  expect(host.textContent).not.toContain('777 ms');
  expect(useApp.getState().groups[0].nodes[0].delaysByTarget?.[DEFAULT_LATENCY_URL]).toBe(100);
});

it('左侧分组导航保留原名，一次展示一个组的成员且切换组不切换出口', async () => {
  const select=vi.fn(); useApp.setState({selectNode:select,groups:[
    {name:'业务 / 任意名',type:'URLTest',now:'A',nodes:[{name:'A',type:'Shadowsocks',delay:null}]},
    {name:'私人节点',type:'Selector',now:'B',nodes:[{name:'B',type:'Socks5',delay:null}]},
  ]});
  await render();
  expect(host.querySelector('[aria-label="策略分组"]')).not.toBeNull();
  expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain('A');
  await click('查看分组 私人节点');
  expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain('B');
  expect(select).not.toHaveBeenCalled();
});

it('筛选、策略导航与当前选择组成一个连续的节点浏览工作区', async () => {
  useApp.setState({ groups: [
    { name: '业务 / 任意名', type: 'URLTest', now: 'A', nodes: [{ name: 'A', type: 'Shadowsocks', delay: 42 }] },
    { name: '私人节点', type: 'Selector', now: 'B', nodes: [{ name: 'B', type: 'Socks5', delay: 68 }] },
  ] });
  await render();

  const browser = host.querySelector<HTMLElement>('[aria-label="节点浏览"]');
  expect(browser).not.toBeNull();
  expect(browser?.querySelector('[aria-label="节点工具条"]')).not.toBeNull();
  expect(browser?.querySelector('[aria-label="策略分组"]')).not.toBeNull();

  const current = browser?.querySelector<HTMLElement>('[aria-label="当前选择"]');
  expect(current?.textContent).toContain('A');

  await click('查看分组 私人节点');
  expect(browser?.querySelector<HTMLElement>('[aria-label="当前选择"]')?.textContent).toContain('B');
});

it('自动策略与负载均衡不能手选，负载均衡不显示唯一当前节点', async () => {
  const select=vi.fn();useApp.setState({selectNode:select,groups:[{name:'均衡',type:'LoadBalance',now:'A',nodes:[{name:'A',type:'Shadowsocks',delay:null}]}]});
  await render();
  expect(host.textContent).toContain('多出口');
  expect(rows()[0].classList.contains('selected')).toBe(false);
  expect(rows()[0].querySelector<HTMLButtonElement>('.proxy-node-select')?.disabled).toBe(true);
  expect(rows()[0].querySelector('.proxy-node-meta')?.textContent).toContain('只读');
  await act(async()=>rows()[0].click());expect(select).not.toHaveBeenCalled();
});
it('provider only 显示等待源，链式固定只承诺当前组选择', async()=>{
  useApp.setState({groups:[],kernelPhase:'stopped',profiles:[{id:'fixture',name:'源',url:'',raw:'proxy-providers: {动态源: {type: http}}\nproxy-groups: [{name: 业务, type: select, use: [动态源]}]',updatedAt:0,userinfo:null,updateIntervalHours:null}]});
  await render();expect(host.textContent).toContain('等待节点源');expect(host.textContent).toContain('动态源');
  await act(async()=>useApp.setState({kernelPhase:'running',groups:[{name:'业务',type:'Selector',now:'落地',nodes:[{name:'落地',type:'Socks5',delay:null}]}],profiles:[{id:'fixture',name:'链路',url:'',raw:'proxies: [{name: 落地, type: socks5, dialer-proxy: 前置}, {name: 前置, type: ss}]',updatedAt:0,userinfo:null,updateIntervalHours:null}]}));
  expect(host.textContent).toContain('配置推断');expect(host.textContent).toContain('前置策略仍可变化');
  expect(button('固定使用 落地').disabled).toBe(false);
});

it('切换订阅时拒绝旧运行快照，不把同名组与节点冒充新订阅已选择',async()=>{
  seed(3);useApp.setState({proxyRuntime:{profileId:'fixture',revision:0,connectedAt:1,proxies:{}}});
  await render();
  await act(async()=>useApp.setState({activeId:'new',profiles:[{id:'new',name:'新订阅',url:'',raw:'proxies: [{name: 新节点, type: ss}]\nproxy-groups: [{name: 线路, type: select, proxies: [新节点]}]',updatedAt:0,userinfo:null,updateIntervalHours:null}]}));
  expect(rows()).toHaveLength(1);expect(rows()[0].textContent).toContain('新节点');
  expect(rows()[0].querySelector<HTMLButtonElement>('.proxy-node-select')!.disabled).toBe(true);
  expect(rows()[0].classList.contains('selected')).toBe(false);
});
