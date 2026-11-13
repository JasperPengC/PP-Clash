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
  return { ...actual, isTauri: true, api: { traySnapshot: vi.fn(), trayAction: vi.fn(), mihomo: vi.fn(), getSystemProxy: vi.fn() } };
});
type Group = { name: string; type: string; now: string | null; manual: boolean; total: number;
  nodes: Array<{ name: string; delay: number | null; selected: boolean }> };
let host: HTMLDivElement; let root: Root; let snapshot: TraySnapshot & { groups: Group[] };
const group = (name: string, type: string, names: string[], now: string | null = names[0]): Group => ({
  name, type, now, manual: type === 'Selector', total: names.length,
  nodes: names.map(name => ({ name, delay: null, selected: name === now })),
});
const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; };
const chooseGroup = async (name: string) => {
  const picker = host.querySelector<HTMLSelectElement>('select[aria-label="浏览策略"]');
  expect(picker, '小面板必须提供策略浏览控件').not.toBeNull();
  await act(async () => { picker!.value = name; picker!.dispatchEvent(new Event('change', { bubbles: true })); });
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
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => path.includes('/delay?') ? { delay: 72 }
    : { extra: { [GITHUB_LATENCY_URL]: { Alive: true, History: [{ delay: 72 }] } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('小面板按速度、接管、模式、订阅策略、节点和页脚呈现', async () => {
  await act(async () => root.render(createElement(TrayPanel)));
  expect([...host.querySelectorAll('.tp-card > [data-tray-section]')].map(node => node.getAttribute('data-tray-section')))
    .toEqual(['speed', 'takeover', 'mode', 'profile', 'group', 'nodes', 'footer']);
});

it('当前节点先进入七个候选预算，剩余候选保留快照顺序', async () => {
  snapshot.groups = [group('工作 | 国际', 'Selector', Array.from({ length: 30 }, (_, i) => `节点 ${i}`), '节点 29')];
  await act(async () => root.render(createElement(TrayPanel)));
  const nodes = [...host.querySelectorAll<HTMLButtonElement>('.tp-node-item')];
  expect(nodes).toHaveLength(7);
  expect(nodes.map(node => node.querySelector('.tp-node-item-name')?.textContent)).toEqual(['节点 29', '节点 0', '节点 1', '节点 2', '节点 3', '节点 4', '节点 5']);
  expect(nodes[0].getAttribute('aria-pressed')).toBe('true');
  expect(api.trayAction).not.toHaveBeenCalled(); expect(api.mihomo).not.toHaveBeenCalled();
});

it('保留配置顺序和父组候选，浏览自动策略不切换也不测速', async () => {
  await act(async () => root.render(createElement(TrayPanel)));
  expect([...host.querySelectorAll('select[aria-label="浏览策略"] option')].map(option => option.textContent)).toEqual(['工作 | 国际', '自动 | 亚洲', '开发']);
  expect(row('自动 | 亚洲')).toBeDefined();
  expect(row('东京')).toBeUndefined();
  await chooseGroup('自动 | 亚洲');
  expect(host.textContent).toContain('URLTest');
  expect(host.textContent).toContain('东京');
  expect(api.trayAction).not.toHaveBeenCalled();
  expect(api.mihomo).not.toHaveBeenCalled();
  expect(api.traySnapshot).toHaveBeenCalledTimes(1);
});

it('含竖线的策略和候选使用结构化动作且不越层写父组', async () => {
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
  if (type === 'LoadBalance' || type === 'Relay') expect(host.querySelector('.tp-policy-current')?.textContent).not.toContain('当前选项');
});

it('测速仅作用当前浏览策略的7个可见候选，并可打开全部节点', async () => {
  snapshot.groups[2] = { ...group('开发', 'Selector', Array.from({ length: 7 }, (_, i) => `代码 ${i}`)), total: 2000 };
  await act(async () => root.render(createElement(TrayPanel)));
  await chooseGroup('开发');
  await clickTest();
  const requests = vi.mocked(api.mihomo).mock.calls.filter(([, path]) => path.includes('/delay?'));
  expect(requests).toHaveLength(7);
  expect(requests.every(([, path]) => decodeURIComponent(path).includes('/代码 '))).toBe(true);
  expect(requests.every(([, path]) => new URL(path, 'https://mock.test').searchParams.get('url') === GITHUB_LATENCY_URL)).toBe(true);
  expect(host.textContent).toContain('2000');
  const all = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('全部节点'));
  expect(all).toBeDefined();
  await act(async () => all!.click());
  expect(api.trayAction).toHaveBeenLastCalledWith('open', 'proxies');
});

it.each(['browse', 'profile-list', 'profile', 'runtime'])('%s变化后旧测速不回填且排队节点不再派发', async change => {
  snapshot.groups[0] = group('工作 | 国际', 'Selector', Array.from({ length: 7 }, (_, i) => `旧节点 ${i}`));
  const requests: Array<ReturnType<typeof deferred<unknown>>> = [];
  vi.mocked(api.mihomo).mockImplementation(async () => { const req = deferred<unknown>(); requests.push(req); return req.promise; });
  await act(async () => root.render(createElement(TrayPanel)));
  await clickTest(); expect(requests).toHaveLength(3);
  if (change === 'browse') await chooseGroup('开发');
  else if (change === 'profile-list') await act(async () => host.querySelector<HTMLButtonElement>('.tp-profile-trigger')!.click());
  else if (change === 'profile') { snapshot.activeProfile = 'p2'; await act(async () => vi.advanceTimersByTimeAsync(900)); }
  else await act(async () => vi.mocked(subscribeRuntimeDisplayStatus).mock.calls[0][0]({ revision: 'test:2', transitioning: true }));
  await act(async () => requests.forEach(request => request.resolve({ delay: 999 })));
  expect(requests).toHaveLength(3);
  expect(host.textContent).not.toContain('999 ms');
});

it('策略消失时安全回退，900ms快照保留仍存在的浏览策略', async () => {
  await act(async () => root.render(createElement(TrayPanel)));
  await chooseGroup('开发');
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="浏览策略"]')?.value).toBe('开发');
  snapshot.groups = snapshot.groups.slice(0, 2);
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="浏览策略"]')?.value).toBe('工作 | 国际');
  expect(api.trayAction).not.toHaveBeenCalled();
});

it('策略读取失败与内核停止显示准确空态，原有主窗口入口仍可用', async () => {
  snapshot.groups = []; snapshot.group = null; snapshot.groupsError = '策略读取失败，等待下次刷新';
  await act(async () => root.render(createElement(TrayPanel)));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('策略读取失败');
  expect(host.querySelector<HTMLButtonElement>('.tp-test')?.disabled).toBe(true);
  snapshot.running = false; snapshot.groupsError = null;
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(host.textContent).toContain('内核运行后显示策略');
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="浏览策略"]')?.disabled).toBe(true);
  const settings = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === '设置')!;
  await act(async () => settings.click());
  expect(api.trayAction).toHaveBeenLastCalledWith('open', 'settings');
});

it('runtime切换中只读显示策略，不能启动测速或节点选择', async () => {
  await act(async () => root.render(createElement(TrayPanel)));
  await act(async () => vi.mocked(subscribeRuntimeDisplayStatus).mock.calls[0][0]({ revision: 'test:2', transitioning: true }));
  await act(async () => vi.advanceTimersByTimeAsync(900));
  await clickTest();
  await act(async () => row('节点 | 美国').click());
  expect(api.mihomo).not.toHaveBeenCalled();
  expect(api.trayAction).not.toHaveBeenCalled();
});

it('旧Relay显示能力未核验，保持只读并不宣称已按候选顺序转发', async () => {
  snapshot.groups = [group('旧中转', 'Relay', ['入口', '出口'], null)];
  snapshot.group = '旧中转';
  await act(async () => root.render(createElement(TrayPanel)));
  const status = host.querySelector('.tp-policy-current')?.textContent;
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
  expect(host.querySelector('.tp-policy-current')?.textContent).toContain('选择状态未知');
  expect(host.querySelector('.tp-policy-current')?.textContent).not.toContain('旧选项');
  expect(host.querySelector('.tp-node-item.selected')).toBeNull();
  expect(row('旧选项').querySelector('svg')).toBeNull();
  expect(row('旧选项').disabled).toBe(true);
  await act(async () => row('旧选项').click());
  expect(api.trayAction).not.toHaveBeenCalled();
});
