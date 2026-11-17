// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OverviewPage } from '../src/pages/Overview';
import { useApp } from '../src/store/app';
import { DEFAULT_LATENCY_URL, GITHUB_LATENCY_URL } from '../src/core/latency';
import { api } from '../src/core/api';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});

const initial = useApp.getInitialState();
let host: HTMLDivElement;
let root: Root;
const openMembers = async () => {
  expect(host.querySelector('#overview-members')?.hasAttribute('hidden')).toBe(false);
};

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ ...initial, kernelPhase: 'running', activeId: 'fixture', notify: vi.fn(),
    routing: { primary: 'Main', managed: ['Main'], roots: ['Main'] },
    groups: [{ name: 'Main', type: 'Selector', now: 'A', nodes: ['A', 'B'].map(name => ({ name, type: 'Shadowsocks', delay: null })) }],
    profiles: [{ id: 'fixture', name: '测试订阅', raw: '', url: '', updatedAt: 0, userinfo: null, updateIntervalHours: null }],
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('首屏常驻当前分组候选，诊断详情仍按需展开', async () => {
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  expect([...host.querySelectorAll('.ov-top-row > section')].map(node => node.getAttribute('aria-label')))
    .toEqual(['当前连接', '上传速率', '下载速率']);
  expect([...host.querySelectorAll('.ov-main-row > section')].map(node => node.getAttribute('aria-label')))
    .toEqual(['实时流量', '当前分组']);
  expect([...host.querySelectorAll('.ov-bottom-row > section')].map(node => node.getAttribute('aria-label')))
    .toEqual(['当前订阅', '服务连通']);
  expect(host.querySelector('#overview-members')?.hasAttribute('hidden')).toBe(false);
  expect(host.querySelector('[aria-label="当前分组候选"]')).not.toBeNull();
  expect(host.querySelector('.ov-common-group')).toBeNull();
  expect(host.querySelector('#diagnostic-details')).toBeNull();
  expect(host.querySelectorAll('.service-tile')).toHaveLength(3);
  expect(host.querySelector('.ov-latency svg circle')).not.toBeNull();
  expect(host.querySelector('.ov-group-tag')?.textContent).toContain('Main');
  expect(host.querySelector('[aria-label="浏览策略"]')).toBeNull();
  expect(host.querySelector('[aria-label="管理策略"]')).toBeNull();
  expect(host.querySelector('[aria-label="查看全部节点"]')).toBeNull();
  expect(host.querySelectorAll('.ov-speed-peak')).toHaveLength(2);
  const select = vi.fn(); useApp.setState({ selectNode: select });
  await openMembers();
  expect(host.querySelector('#overview-members')?.hasAttribute('hidden')).toBe(false);
  expect(select).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-controls="diagnostic-details"]')!.click());
  expect(host.querySelector('section[aria-label="IP 质量"]')).not.toBeNull();
  expect(host.querySelector('section[aria-label="泄漏检查"]')).not.toBeNull();
});

it('未添加订阅时将导入操作放在订阅卡中，不挤占连接卡的出口信息行', async () => {
  useApp.setState({ kernelPhase: 'stopped', activeId: null, profiles: [], groups: [] });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));

  const connection = host.querySelector('section[aria-label="当前连接"]')!;
  const subscription = host.querySelector('section[aria-label="当前订阅"]')!;
  expect(connection.querySelector('.ov-hero-actions')).toBeNull();
  expect(connection.querySelector('.ov-hero-node')?.textContent).toContain('尚未配置出口');
  expect(subscription.querySelector('.quota-card-name')?.textContent).toContain('尚未添加订阅');
  expect(subscription.querySelector('.quota-empty')?.textContent).toContain('添加订阅后');
  expect(subscription.querySelector<HTMLButtonElement>('[aria-label="导入订阅"]')).not.toBeNull();
});

it('当前候选优先，其余按目标延迟排序，未测与失败各保留自己的标签', async () => {
  useApp.setState({ groups: [{ name: 'Main', type: 'Selector', now: '慢速当前', nodes: [
    { name: '慢速当前', type: 'Trojan', delay: 280, delaysByTarget: { [DEFAULT_LATENCY_URL]: 280 } },
    { name: '未知', type: 'Trojan', delay: null },
    { name: '失败', type: 'Trojan', delay: null, delaysByTarget: { [DEFAULT_LATENCY_URL]: null } },
    { name: '较快', type: 'Trojan', delay: 44, delaysByTarget: { [DEFAULT_LATENCY_URL]: 44 } },
    { name: '最快', type: 'Trojan', delay: 21, delaysByTarget: { [DEFAULT_LATENCY_URL]: 21 } },
  ] }] });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  await openMembers();
  const rows = [...host.querySelectorAll<HTMLButtonElement>('.group-node')];
  expect(rows.map(row => row.title)).toEqual(['慢速当前', '最快', '较快', '失败', '未知']);
  expect(rows[0].getAttribute('aria-pressed')).toBe('true');
  expect(rows[3].textContent).toContain('失败');
  expect(rows[4].textContent).toContain('未测');
});

it('2000 个候选可在卡内浏览到末尾，滚动不测速也不切节点', async () => {
  const selectNode = vi.fn(); const testDelay = vi.fn();
  useApp.setState({ selectNode, testDelay, groups: [{ name: 'Main', type: 'Selector', now: '候选 0000',
    nodes: Array.from({ length: 2000 }, (_, i) => ({ name: `候选 ${String(i).padStart(4, '0')}`, type: 'Trojan', delay: i + 1,
      delaysByTarget: { [DEFAULT_LATENCY_URL]: i + 1 } })),
  }] });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  await openMembers();
  const list = host.querySelector<HTMLElement>('[aria-label="当前分组候选"]');
  expect(list).not.toBeNull();
  expect(host.querySelectorAll('.group-node').length).toBeLessThanOrEqual(20);
  await act(async () => { list!.scrollTop = 2000 * 44; list!.dispatchEvent(new Event('scroll', { bubbles: true })); });
  expect([...host.querySelectorAll<HTMLElement>('.group-node')].some(row => row.title === '候选 1999')).toBe(true);
  expect(host.querySelectorAll('.group-node').length).toBeLessThanOrEqual(20);
  expect(selectNode).not.toHaveBeenCalled(); expect(testDelay).not.toHaveBeenCalled();
});

it('无效的当前节点目标延迟显示失败，不作为零毫秒成功读数', async () => {
  useApp.setState({ groups: [{ name: 'Main', type: 'Selector', now: 'A', nodes: [
    { name: 'A', type: 'Trojan', delay: 0, delaysByTarget: { [DEFAULT_LATENCY_URL]: 0 } },
  ] }] });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  const connection = host.querySelector('section[aria-label="当前连接"]')!;
  expect(connection.querySelector('.ov-latency')?.textContent).toBe('失败');
});

it('直连模式不显示或自动测速 Main 的闲置代理候选', async () => {
  vi.useFakeTimers();
  try {
    const testDelay = vi.fn().mockResolvedValue(64);
    useApp.setState(state => ({ settings: { ...state.settings, mode: 'direct' }, testDelay,
      refreshGroups: vi.fn().mockResolvedValue(true), groups: [{ name: 'Main', type: 'Selector', now: 'A',
        nodes: [{ name: 'A', type: 'Trojan', delay: null }] }],
    }));
    await act(async () => root.render(createElement(OverviewPage, { active: true })));
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    const connection = host.querySelector('section[aria-label="当前连接"]')!;
    expect(connection.querySelector('.ov-hero-node')?.textContent).toBe('DIRECT');
    expect(testDelay).not.toHaveBeenCalled();
    expect(connection.querySelector('.ov-latency')?.textContent).toBe('直连');
    expect(connection.querySelector<HTMLButtonElement>('.ov-latency')?.disabled).toBe(true);
    expect(connection.querySelector('.ov-hero-route')?.textContent).toBe('直连模式');
  } finally { vi.useRealTimers(); }
});

it('其他分组不影响主卡实际 Main 连接的测速目标、读数和颜色', async () => {
  const testDelay = vi.fn().mockResolvedValue(180);
  useApp.setState({ testDelay, groups: [
    { name: 'Main', type: 'Selector', now: 'A', nodes: [{ name: 'A', type: 'Trojan', delay: 320, delaysByTarget: { [DEFAULT_LATENCY_URL]: 320 } }] },
    { name: '开发', type: 'Selector', now: 'B', nodes: [{ name: 'B', type: 'Trojan', delay: 21, delaysByTarget: { [GITHUB_LATENCY_URL]: 21 } }] },
  ] });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  const connection = host.querySelector('section[aria-label="当前连接"]')!;
  const mainLatency = () => connection.querySelector<HTMLButtonElement>('.ov-latency')!;
  const target = mainLatency().title;
  expect(target).toContain('Google HTTPS');
  expect(host.querySelector('.ov-group-tag')?.textContent).toContain('Main');
  expect(host.querySelector('[aria-label="浏览策略"]')).toBeNull();
  expect(mainLatency().title).toBe(target);
  expect(mainLatency().getAttribute('aria-label')).toBe('测速当前节点，延迟 320 毫秒');
  expect(mainLatency().classList.contains('bad')).toBe(true);
  expect(mainLatency().textContent).toBe('320 ms');
  expect(connection.querySelector('.ov-hero-route')?.textContent).toBe('Main');
  expect(mainLatency().disabled).toBe(false);
  await act(async () => mainLatency().click());
  expect(testDelay).toHaveBeenCalledExactlyOnceWith('A', DEFAULT_LATENCY_URL);
  expect(mainLatency().textContent).toBe('180 ms');
  expect(host.querySelector('.group-card')?.textContent).toContain('180 ms');
});

it.each([
  ['rule', 'DIRECT', '直连', 'Main · 直连出口'],
  ['rule', 'REJECT', '拒绝', 'Main · 拒绝连接'],
  ['rule', 'REJECT-DROP', '丢弃', 'Main · 丢弃连接'],
  ['global', 'DIRECT', '直连', 'GLOBAL · 直连出口'],
  ['global', 'REJECT', '拒绝', 'GLOBAL · 拒绝连接'],
  ['global', 'REJECT-DROP', '丢弃', 'GLOBAL · 丢弃连接'],
] as const)('%s 模式保留已确认的 %s 终端，不显示为未知或测速代理', async (mode, terminal, reading, auxiliaryLabel) => {
  const testDelay = vi.fn();
  useApp.setState(state => ({ settings: { ...state.settings, mode }, testDelay }));
  vi.mocked(api.mihomo).mockResolvedValue({ proxies: {
    GLOBAL: { type: 'Selector', now: terminal, all: ['A', terminal] },
    Main: { type: 'Selector', now: terminal, all: ['A', terminal] },
    A: { type: 'Trojan', extra: { [DEFAULT_LATENCY_URL]: { Alive: true, History: [{ delay: 21 }] } } },
    [terminal]: { type: terminal },
  } });
  await act(async () => { await useApp.getState().refreshGroups(); root.render(createElement(OverviewPage, { active: false })); });
  const connection = host.querySelector('section[aria-label="当前连接"]')!;
  const latency = connection.querySelector<HTMLButtonElement>('.ov-latency')!;
  expect(connection.querySelector('.ov-hero-node')?.textContent).toBe(terminal);
  expect(connection.querySelector('.ov-hero-route')?.textContent).toBe(auxiliaryLabel);
  expect(latency.textContent).toBe(reading);
  expect(latency.disabled).toBe(true);
  expect(latency.title).not.toContain('HTTPS');
  expect(latency.getAttribute('aria-label')).not.toContain('测速当前节点');
  await act(async () => latency.click());
  expect(testDelay).not.toHaveBeenCalled();
});

it('全局模式的状态与当前分组来自 GLOBAL 快照，不借用订阅首组延迟', async () => {
  useApp.setState(state => ({ settings: { ...state.settings, mode: 'global' } }));
  vi.mocked(api.mihomo).mockResolvedValue({ proxies: {
    GLOBAL: { type: 'Selector', now: '全局出口', all: ['A', '全局出口'] },
    Main: { type: 'Selector', now: 'A', all: ['A'] },
    A: { type: 'Trojan', extra: { [DEFAULT_LATENCY_URL]: { Alive: true, History: [{ delay: 21 }] } } },
    全局出口: { type: 'Trojan', extra: { [DEFAULT_LATENCY_URL]: { Alive: true, History: [{ delay: 99 }] } } },
  } });
  await act(async () => { await useApp.getState().refreshGroups(); root.render(createElement(OverviewPage, { active: false })); });
  expect(host.querySelector('section[aria-label="当前连接"] .ov-hero-node')?.textContent).toBe('全局出口');
  expect(host.querySelector('section[aria-label="当前连接"] .ov-latency')?.textContent).toBe('99 ms');
  expect(host.querySelector('.ov-group-tag')?.textContent).toContain('GLOBAL');
  expect(host.querySelector<HTMLButtonElement>('.group-node')?.title).toBe('全局出口');
});

it('当前分组只读展示名称，不再提供分组切换或全部节点跳转', async () => {
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  expect(host.querySelector('.ov-group-tag')?.textContent).toContain('Main');
  expect(host.querySelector('[aria-label="浏览策略"]')).toBeNull();
  expect(host.querySelector('[aria-label="查看全部节点"]')).toBeNull();
});

it('概览切换节点时保持当前选择可辨认，并在完成前阻止重复切换', async () => {
  let finish!: (value: boolean) => void;
  const selectNode = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  useApp.setState({ selectNode });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  await openMembers();
  const nodes = [...host.querySelectorAll<HTMLButtonElement>('.group-node')];
  expect(nodes[0].getAttribute('aria-pressed')).toBe('true');
  await act(async () => nodes[1].click());
  expect(selectNode).toHaveBeenCalledWith('Main', 'B');
  expect(nodes.every(node => node.disabled)).toBe(true);
  await act(async () => nodes[0].click());
  expect(selectNode).toHaveBeenCalledOnce();
  await act(async () => finish(true));
  expect(nodes.every(node => !node.disabled)).toBe(true);
});

it('诊断展开不触发检测，收起后焦点仍留在开合按钮', async () => {
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  const toggle = host.querySelector<HTMLButtonElement>('[aria-controls="diagnostic-details"]')!;
  toggle.focus();
  expect(host.querySelector('#diagnostic-details')).toBeNull();
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('#diagnostic-details')).not.toBeNull();
  await act(async () => toggle.click());
  expect(host.querySelector('#diagnostic-details')).toBeNull();
  expect(document.activeElement).toBe(toggle);
});

it('当前分组跟随实际负载均衡策略，不声称唯一出口或允许手动选成员', async () => {
  const selectNode = vi.fn();
  const testDelay = vi.fn();
  useApp.setState({ selectNode, testDelay, routing: { primary: '我的均衡', managed: ['我的均衡'] }, groups: [...useApp.getState().groups,
    { name: '我的均衡', type: 'LoadBalance', now: 'B', nodes: ['A', 'B'].map(name => ({ name, type: 'Trojan', delay: 20 })) },
  ] });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  await openMembers();
  expect(host.querySelector('.ov-group-tag')?.textContent).toBe('我的均衡');
  expect(host.querySelector('.ov-group-tag')?.getAttribute('title')).toContain('按连接分配');
  expect(selectNode).not.toHaveBeenCalled();
  expect(testDelay).not.toHaveBeenCalled();
  expect(host.querySelector('#overview-nodes')?.hasAttribute('hidden')).toBe(false);
  const members = [...host.querySelectorAll<HTMLButtonElement>('.group-node')];
  expect(members.every(button => button.disabled)).toBe(true);
  expect(members.some(button => button.getAttribute('aria-pressed') === 'true')).toBe(false);
});

it('切换订阅后成员区回到该订阅的分组，不停留在上一份订阅', async () => {
  const base = useApp.getState().profiles[0];
  useApp.setState({ profiles: [base, { ...base, id: 'other', name: '另一份订阅', raw: 'proxies:\n  - { name: C, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: demo }\nproxy-groups:\n  - { name: 备用组, type: select, proxies: [C] }\nrules: [MATCH,备用组]' }] });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  expect(host.querySelector('.ov-group-tag')?.textContent).toBe('Main');
  expect(host.querySelector('#overview-nodes')?.textContent).toContain('B');
  await act(async () => useApp.setState({ activeId: 'other', kernelPhase: 'stopped', connectedAt: null, routing: { primary: '备用组', managed: ['备用组'], roots: ['备用组'] } }));
  expect(host.querySelector('#overview-nodes')?.textContent).toContain('C');
  expect(host.querySelector('#overview-nodes')?.textContent).not.toContain('B');
});

it('离线显示订阅首组与只读标签，不能浏览其他组或切换节点', async () => {
  const selectNode = vi.fn();
  useApp.setState({ kernelPhase: 'stopped', selectNode, profiles: [{
    ...useApp.getState().profiles[0], raw: 'proxies:\n  - { name: A, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: demo }\n  - { name: B, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: demo }\nproxy-groups:\n  - { name: 第一组, type: select, proxies: [A] }\n  - { name: 第二组, type: select, proxies: [B] }\nrules: [MATCH,第一组]',
  }] });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  expect(host.querySelector('.ov-group-tag')?.textContent).toBe('第一组');
  expect(host.querySelector('[aria-label="浏览策略"]')).toBeNull();
  const members = [...host.querySelectorAll<HTMLButtonElement>('.group-node')];
  expect(members).toHaveLength(1);
  expect(members[0].textContent).toContain('A');
  expect(members[0].disabled).toBe(true);
  expect(selectNode).not.toHaveBeenCalled();
});


it.each(['running', 'stopped'] as const)('概览在 %s 时仅通过系统代理和 TUN 控制接管，不提供重复连接按钮', async kernelPhase => {
  const toggleSystemProxy = vi.fn().mockResolvedValue(undefined);
  const setTun = vi.fn().mockResolvedValue(undefined);
  const startKernel = vi.fn(); const stopKernel = vi.fn();
  useApp.setState({ kernelPhase, sysProxyEnabled: false, tunEnabled: false, toggleSystemProxy, setTun, startKernel, stopKernel });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  expect(host.querySelector('.ov-connection-button')).toBeNull();
  expect(host.querySelector('.page-head [aria-label="流量接管"]')).not.toBeNull();
  expect(host.querySelector('.page-scroll [aria-label="流量接管"]')).toBeNull();
  const proxy = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="系统代理"]')!;
  const tun = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="TUN 模式"]')!;
  expect(proxy.disabled).toBe(false); expect(tun.disabled).toBe(false);
  await act(async () => proxy.click());
  expect(toggleSystemProxy).toHaveBeenCalledExactlyOnceWith(true);
  await act(async () => tun.click());
  expect(setTun).toHaveBeenCalledExactlyOnceWith(true);
  expect(startKernel).not.toHaveBeenCalled(); expect(stopKernel).not.toHaveBeenCalled();
});
