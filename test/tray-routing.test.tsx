// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TrayPanel } from '../src/components/TrayPanel';
import { subscribeRuntimeDisplayStatus } from '../src/core/runtime-display-events';
import { api, type TraySnapshot } from '../src/core/api';
import { GITHUB_LATENCY_URL } from '../src/core/latency';

vi.mock('../src/core/runtime-display-events', () => ({ subscribeRuntimeDisplayStatus: vi.fn() }));
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: { traySnapshot: vi.fn(), trayAction: vi.fn(), trafficRates: vi.fn(), mihomo: vi.fn(), getSystemProxy: vi.fn() } };
});
type Group = { name: string; type: string; now: string | null; manual: boolean; total: number;
  nodes: Array<{ name: string; delay: number | null; selected: boolean }> };
let host: HTMLDivElement; let root: Root; let snapshot: TraySnapshot & { groups: Group[] };
const group = (name: string, type: string, names: string[], now: string | null = names[0]): Group => ({
  name, type, now, manual: type === 'Selector', total: names.length,
  nodes: names.map(name => ({ name, delay: null, selected: name === now })),
});
const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; };
const activateGroup = async (name: string) => {
  snapshot.group = name;
  await act(async () => vi.advanceTimersByTimeAsync(3000));
};
const row = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.tp-node-item')].find(node => node.textContent?.includes(name))!;
const clickTest = () => act(async () => host.querySelector<HTMLButtonElement>('.tp-test')!.click());
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.mocked(subscribeRuntimeDisplayStatus).mockImplementation(receive => { receive({ revision: 'test:1', transitioning: false }); return vi.fn(); });
  snapshot = { running: true, sysProxy: false, tun: false, mode: 'rule', group: '工作 | 国际', node: '自动 | 亚洲',
    up: 0, down: 0, showSpeed: true, controllerPort: 9090, controllerSecret: '', activeProfile: 'p1', profiles: [],
    nodes: [], groups: [group('工作 | 国际', 'Selector', ['自动 | 亚洲', '节点 | 美国', 'DIRECT']),
      group('自动 | 亚洲', 'URLTest', ['东京', '香港']), group('开发', 'Selector', ['代码节点'])] };
  vi.mocked(api.traySnapshot).mockImplementation(async () => structuredClone(snapshot));
  vi.mocked(api.trayAction).mockResolvedValue(undefined);
  vi.mocked(api.trafficRates).mockResolvedValue([0, 0]);
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => path.includes('/delay?') ? { delay: 72 }
    : { extra: { [GITHUB_LATENCY_URL]: { Alive: true, History: [{ delay: 72 }] } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('当前生效分组只显示一次且是标签，不提供重复的订阅行与分组选择器', async () => {
  snapshot.profiles = [{ id: 'p1', name: '工作 | 国际' }];
  await act(async () => root.render(createElement(TrayPanel)));
  expect(host.querySelector('[aria-label="浏览策略"]')).toBeNull();
  expect(host.querySelector('.tp-policy-meta')).toBeNull();
  expect(host.querySelector('.tp-current-group')?.textContent).toBe('自动 | 亚洲');
  expect(host.querySelectorAll('.tp-profile-trigger')).toHaveLength(1);
  expect(host.querySelector('.tp-foot')?.contains(host.querySelector('.tp-profile-trigger'))).toBe(true);
  expect(host.querySelector('.tp-profile-trigger')?.textContent).toContain('切换订阅');
  expect(host.querySelector('.tp-profile-trigger')?.getAttribute('title')).toBe('当前订阅：工作 | 国际');
  expect(row('东京')).toBeDefined();
  expect(row('自动 | 亚洲')).toBeUndefined();
  expect(row('节点 | 美国')).toBeUndefined();
  expect(api.trayAction).not.toHaveBeenCalled();
});

it('千条候选全部可滚动访问，渲染有界且不改变选中节点的动作身份', async () => {
  snapshot.groups = [group('工作 | 国际', 'Selector', Array.from({ length: 1000 }, (_, i) => `节点 ${i}`), '节点 999')];
  await act(async () => root.render(createElement(TrayPanel)));
  const nodes = [...host.querySelectorAll<HTMLButtonElement>('.tp-node-item')];
  expect(nodes.length).toBeLessThanOrEqual(30);
  expect(nodes[0].getAttribute('aria-pressed')).toBe('true');
  expect(nodes[0].textContent).toContain('节点 999');
  const list = host.querySelector<HTMLElement>('[aria-label="当前分组节点"]')!;
  expect(list).toBeTruthy();
  await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true})));
  expect(row('节点 998')).toBeDefined();
  await act(async () => row('节点 998').click());
  expect(api.trayAction).toHaveBeenLastCalledWith('node', {group: '工作 | 国际', node: '节点 998'});
});

it('主出口变化后自动追踪生效分组，不保留已失效的浏览分组', async () => {
  await act(async () => root.render(createElement(TrayPanel)));
  expect(host.querySelector('.tp-current-group')?.textContent).toBe('自动 | 亚洲');
  snapshot.groups[0].now = '开发';
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(host.querySelector('.tp-current-group')?.textContent).toBe('开发');
  expect(row('代码节点')).toBeDefined();
  expect(row('东京')).toBeUndefined();
  expect(api.trayAction).not.toHaveBeenCalled();
});

it('全局模式沿 GLOBAL 的当前选项追踪生效分组', async () => {
  snapshot.mode = 'global';
  snapshot.groups.push(group('GLOBAL', 'Selector', ['开发', '工作 | 国际'], '开发'));
  await act(async () => root.render(createElement(TrayPanel)));
  expect(host.querySelector('.tp-current-group')?.textContent).toBe('开发');
  expect(row('代码节点')).toBeDefined();
  expect(row('东京')).toBeUndefined();
});

it('与概览一样排除机场的流量和到期提示节点', async () => {
  snapshot.groups = [group('工作 | 国际', 'Selector', ['真实线路', '剩余流量：1.91 TB', '套餐到期：2027-03-16'])];
  await act(async () => root.render(createElement(TrayPanel)));
  expect(host.querySelectorAll('.tp-node-item')).toHaveLength(1);
  expect(host.querySelector('.tp-group-count')?.textContent).toBe('1 个节点');
});

it('含竖线的策略和候选使用结构化动作且不越层写父组', async () => {
  snapshot.groups[0].now = '节点 | 美国';
  await act(async () => root.render(createElement(TrayPanel)));
  await act(async () => row('节点 | 美国')?.click());
  expect(api.trayAction).toHaveBeenLastCalledWith('node', { group: '工作 | 国际', node: '节点 | 美国' });
  await act(async () => row('自动 | 亚洲').click());
  expect(api.trayAction).toHaveBeenLastCalledWith('node', { group: '工作 | 国际', node: '自动 | 亚洲' });
});

it.each(['URLTest', 'Fallback', 'LoadBalance', 'Relay', 'FuturePolicy'])('%s 策略只能浏览，不能伪装成可手选', async type => {
  snapshot.groups = [group('任意策略', type, ['A', 'B'], ['LoadBalance', 'Relay', 'FuturePolicy'].includes(type) ? null : 'A')];
  snapshot.group = '任意策略';
  await act(async () => root.render(createElement(TrayPanel)));
  expect(row('A')).toBeDefined();
  expect(row('B').disabled).toBe(true);
  await act(async () => row('B').click());
  expect(api.trayAction).not.toHaveBeenCalled();
  if (type === 'LoadBalance' || type === 'Relay') expect(host.querySelector('.tp-current-group')?.getAttribute('title')).not.toContain('当前选项');
});

it('测速覆盖当前生效分组的全部候选，而非只测可见七条', async () => {
  snapshot.groups[0].now = '开发';
  snapshot.groups[2] = group('开发', 'Selector', Array.from({ length: 40 }, (_, i) => `代码 ${i}`));
  await act(async () => root.render(createElement(TrayPanel)));
  await clickTest();
  const requests = vi.mocked(api.mihomo).mock.calls.filter(([, path]) => path.includes('/delay?'));
  expect(requests).toHaveLength(40);
  expect(requests.every(([, path]) => decodeURIComponent(path).includes('/代码 '))).toBe(true);
  expect(requests.every(([, path]) => new URL(path, 'https://mock.test').searchParams.get('url') === GITHUB_LATENCY_URL)).toBe(true);
  expect(host.querySelector('.tp-test')?.getAttribute('title')).toContain('40 个节点');
});

it.each(['browse', 'profile-list', 'profile', 'runtime'])('%s变化后旧测速不回填且排队节点不再派发', async change => {
  snapshot.groups[0] = group('工作 | 国际', 'Selector', Array.from({ length: 7 }, (_, i) => `旧节点 ${i}`));
  const requests: Array<ReturnType<typeof deferred<unknown>>> = [];
  vi.mocked(api.mihomo).mockImplementation(async () => { const req = deferred<unknown>(); requests.push(req); return req.promise; });
  await act(async () => root.render(createElement(TrayPanel)));
  await clickTest(); expect(requests).toHaveLength(3);
  if (change === 'browse') await activateGroup('开发');
  else if (change === 'profile-list') await act(async () => host.querySelector<HTMLButtonElement>('.tp-profile-trigger')!.click());
  else if (change === 'profile') { snapshot.activeProfile = 'p2'; await act(async () => vi.advanceTimersByTimeAsync(3000)); }
  else await act(async () => vi.mocked(subscribeRuntimeDisplayStatus).mock.calls[0][0]({ revision: 'test:2', transitioning: true }));
  await act(async () => requests.forEach(request => request.resolve({ delay: 999 })));
  expect(requests).toHaveLength(3);
  expect(host.textContent).not.toContain('999 ms');
});

it('订阅小卡片保留用量与独立动作，选择后恢复当前分组节点区', async () => {
  snapshot.profiles = [{id:'p1',name:'工作 | 国际'}, {id:'p2',name:'备用'}];
  await act(async () => root.render(createElement(TrayPanel)));
  await act(async () => host.querySelector<HTMLButtonElement>('.tp-profile-trigger')!.click());
  expect(host.querySelector('.tp-node-list')).toBeNull();
  expect(host.querySelector('.tp-profile-card[data-selected="true"] .tp-profile-name')?.textContent).toBe('工作 | 国际');
  const option = host.querySelector<HTMLButtonElement>('[aria-label="使用订阅 备用"]')!;
  await act(async () => option.click());
  expect(api.trayAction).toHaveBeenLastCalledWith('profile', 'p2');
  expect(host.querySelector('.tp-node-list')).not.toBeNull();
});

it('顶部品牌与订阅右侧的按钮都能直接进入主界面', async () => {
  await act(async () => root.render(createElement(TrayPanel)));
  const brand = host.querySelector<HTMLButtonElement>('.tp-brand-button')!;
  expect(brand).toBeTruthy();
  await act(async () => brand.click());
  expect(api.trayAction).toHaveBeenLastCalledWith('open', 'overview');
  const home = host.querySelector<HTMLButtonElement>('.tp-profile-trigger + button')!;
  expect(home.getAttribute('aria-label')).toBe('打开主界面');
  await act(async () => home.click());
  expect(api.trayAction).toHaveBeenLastCalledWith('open', 'overview');
});

it('订阅更新等待真实结果，失败可重试且不触发切换', async () => {
  snapshot.profiles = [{ id: 'p1', name: '主订阅', userinfo: { upload: 0, download: 1024 ** 3, total: 4 * 1024 ** 3, expire: 0 } }];
  await act(async () => root.render(createElement(TrayPanel)));
  await act(async () => host.querySelector<HTMLButtonElement>('.tp-profile-trigger')!.click());
  expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
  const update = host.querySelector<HTMLButtonElement>('[aria-label="更新订阅 主订阅"]')!;
  let reject!: (error: Error) => void;
  vi.mocked(api.trayAction).mockReturnValueOnce(new Promise((_, no) => { reject = no; }));
  await act(async () => update.click());
  expect(update.disabled).toBe(true);
  expect(api.trayAction).toHaveBeenLastCalledWith('refresh-profile', 'p1');
  await act(async () => reject(new Error('network failed')));
  expect(update.disabled).toBe(false);
  expect(host.querySelector('.tp-profile-card [role="alert"]')?.textContent).toContain('更新失败');
  expect(host.querySelector('.tp-profile-list')).toBeTruthy();
  await act(async () => update.click());
  expect(host.querySelector('.tp-profile-card [role="status"]')?.textContent).toBe('已更新');
  expect(vi.mocked(api.trayAction).mock.calls.every(([action]) => action === 'refresh-profile')).toBe(true);
});

it('小面板多个订阅可独立更新，一项失败不停止另一项的旋转和禁用状态', async () => {
  snapshot.profiles = [{ id: 'p1', name: '主订阅' }, { id: 'p2', name: '备用订阅' }];
  await act(async () => root.render(createElement(TrayPanel)));
  await act(async () => host.querySelector<HTMLButtonElement>('.tp-profile-trigger')!.click());
  const first = host.querySelector<HTMLButtonElement>('[aria-label="更新订阅 主订阅"]')!;
  const second = host.querySelector<HTMLButtonElement>('[aria-label="更新订阅 备用订阅"]')!;
  let reject!: (error: Error) => void;
  const pending = deferred<void>();
  vi.mocked(api.trayAction).mockImplementation(async (_action, id) => {
    if (id === 'p1') return new Promise((_, no) => { reject = no; });
    return pending.promise;
  });
  await act(async () => first.click());
  expect(first.disabled).toBe(true);
  expect(first.querySelector('svg.spin')).not.toBeNull();
  expect(second.disabled).toBe(false);
  await act(async () => second.click());
  await act(async () => reject(new Error('更新失败')));
  expect(first.disabled).toBe(false);
  expect(first.querySelector('svg.spin')).toBeNull();
  expect(second.disabled).toBe(true);
  expect(second.querySelector('svg.spin')).not.toBeNull();
  await act(async () => pending.resolve());
  expect(second.disabled).toBe(false);
  expect(second.querySelector('svg.spin')).toBeNull();
});

it('策略读取失败与内核停止显示准确空态，原有主窗口入口仍可用', async () => {
  snapshot.groups = []; snapshot.group = null; snapshot.groupsError = '策略读取失败，等待下次刷新';
  await act(async () => root.render(createElement(TrayPanel)));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('策略读取失败');
  expect(host.querySelector<HTMLButtonElement>('.tp-test')?.disabled).toBe(true);
  snapshot.running = false; snapshot.groupsError = null;
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(host.textContent).toContain('内核运行后显示策略');
  expect(host.querySelector('.tp-current-group')?.textContent).toBe('暂无分组');
  const settings = [...host.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '设置')!;
  await act(async () => settings.click());
  expect(api.trayAction).toHaveBeenLastCalledWith('open', 'settings');
});

it('runtime切换中只读显示策略，不能启动测速或节点选择', async () => {
  await act(async () => root.render(createElement(TrayPanel)));
  await act(async () => vi.mocked(subscribeRuntimeDisplayStatus).mock.calls[0][0]({ revision: 'test:2', transitioning: true }));
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  await clickTest();
  await act(async () => row('东京').click());
  expect(api.mihomo).not.toHaveBeenCalled();
  expect(api.trayAction).not.toHaveBeenCalled();
});

it('旧Relay显示能力未核验，保持只读并不宣称已按候选顺序转发', async () => {
  snapshot.groups = [group('旧中转', 'Relay', ['入口', '出口'], null)];
  snapshot.group = '旧中转';
  await act(async () => root.render(createElement(TrayPanel)));
  const status = host.querySelector('.tp-current-group')?.getAttribute('title');
  expect(status).toContain('能力未核验');
  expect(status).not.toContain('按候选顺序转发');
  expect(status).not.toContain('无唯一出口');
  expect(row('入口').disabled).toBe(true);
  expect(host.querySelector('.tp-node-item.selected')).toBeNull();
});

it('缺少类型的旧快照不将旧now或selected伪装成已确认选择', async () => {
  snapshot.nodes = [{ name: '旧选项', delay: 21, selected: true }, { name: '其他候选', delay: null, selected: false }];
  snapshot.node = '旧选项';
  delete (snapshot as TraySnapshot).groups;
  await act(async () => root.render(createElement(TrayPanel)));
  expect(host.querySelector('.tp-current-group')?.getAttribute('title')).toContain('选择状态未知');
  expect(host.querySelector('.tp-current-group')?.getAttribute('title')).not.toContain('旧选项');
  expect(host.querySelector('.tp-node-item.selected')).toBeNull();
  expect(row('旧选项').querySelector('svg')).toBeNull();
  expect(row('旧选项').disabled).toBe(true);
  await act(async () => row('旧选项').click());
  expect(api.trayAction).not.toHaveBeenCalled();
});
