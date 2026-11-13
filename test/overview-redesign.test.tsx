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
const browseGroup = async (name: string) => {
  const picker = host.querySelector<HTMLSelectElement>('select[aria-label="浏览策略"]')!;
  await act(async () => { picker.value = name; picker.dispatchEvent(new Event('change', { bubbles: true })); });
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

it('常用首屏按状态速率、接管订阅、流量分组与三个诊断区域组织', async () => {
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  for (const name of ['当前连接', '实时流量', '当前分组', '服务连通', 'IP 质量', '泄漏检查']) {
    expect(host.querySelector(`section[aria-label="${name}"]`), name).not.toBeNull();
  }
  expect([...host.querySelectorAll('.ov-top-row > section')].map(node => node.getAttribute('aria-label')))
    .toEqual(['当前连接', '上传速率', '下载速率']);
  expect([...host.querySelectorAll('.ov-control-row > section')].map(node => node.getAttribute('aria-label')))
    .toEqual(['流量接管', '当前订阅']);
  expect([...host.querySelectorAll('.ov-main-row > section')].map(node => node.getAttribute('aria-label')))
    .toEqual(['实时流量', '当前分组']);
  expect(host.querySelectorAll('.ov-diagnostic-row > section')).toHaveLength(3);
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

it('浏览 GitHub 分组后主卡目标、读数、颜色、辅助标签和重测仍属于实际 Main 连接', async () => {
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
  await browseGroup('开发');
  expect(mainLatency().title).toBe(target);
  expect(mainLatency().getAttribute('aria-label')).toBe('测速当前节点，延迟 320 毫秒');
  expect(mainLatency().classList.contains('bad')).toBe(true);
  expect(mainLatency().textContent).toBe('320 ms');
  expect(connection.querySelector('.ov-hero-route')?.textContent).toBe('Main');
  expect(mainLatency().disabled).toBe(false);
  await act(async () => mainLatency().click());
  expect(testDelay).toHaveBeenCalledExactlyOnceWith('A', DEFAULT_LATENCY_URL);
  expect(mainLatency().textContent).toBe('180 ms');
  expect(host.querySelector('.ov-routing')?.textContent).not.toContain('180 ms');
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
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="浏览策略"]')?.value).toBe('GLOBAL');
  expect(host.querySelector<HTMLButtonElement>('.group-node')?.title).toBe('全局出口');
});

it('当前分组始终提供全部节点入口，小分组也能直接进入节点页', async () => {
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  const open = host.querySelector<HTMLButtonElement>('.ov-routing [aria-label="查看全部节点"]');
  expect(open).not.toBeNull();
  const navigate = vi.fn();
  window.addEventListener('ppclash:nav', navigate);
  try {
    await act(async () => open!.click());
    expect(navigate).toHaveBeenCalledOnce();
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toBe('proxies');
  } finally { window.removeEventListener('ppclash:nav', navigate); }
});

it('概览切换节点时保持当前选择可辨认，并在完成前阻止重复切换', async () => {
  let finish!: (value: boolean) => void;
  const selectNode = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  useApp.setState({ selectNode });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
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

it('查看策略只展开成员，不切换节点，负载均衡不声称唯一出口', async () => {
  const selectNode = vi.fn();
  const testDelay = vi.fn();
  useApp.setState({ selectNode, testDelay, groups: [...useApp.getState().groups,
    { name: '我的均衡', type: 'LoadBalance', now: 'B', nodes: ['A', 'B'].map(name => ({ name, type: 'Trojan', delay: 20 })) },
  ] });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  const policy = host.querySelector<HTMLOptionElement>('option[value="我的均衡"]')!;
  expect(policy.textContent).toContain('按连接分配');
  expect(policy.textContent).not.toContain('B');
  await browseGroup('我的均衡');
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
  await browseGroup('Main');
  expect(host.querySelector('#overview-nodes')?.textContent).toContain('B');
  await act(async () => useApp.setState({ activeId: 'other', kernelPhase: 'stopped', connectedAt: null, routing: { primary: '备用组', managed: ['备用组'], roots: ['备用组'] } }));
  expect(host.querySelector('#overview-nodes')?.textContent).toContain('C');
  expect(host.querySelector('#overview-nodes')?.textContent).not.toContain('B');
});

it('离线查看任意订阅分组时显示该组成员，且不能发起切换', async () => {
  const selectNode = vi.fn();
  useApp.setState({ kernelPhase: 'stopped', selectNode, profiles: [{
    ...useApp.getState().profiles[0], raw: 'proxies:\n  - { name: A, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: demo }\n  - { name: B, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: demo }\nproxy-groups:\n  - { name: 第一组, type: select, proxies: [A] }\n  - { name: 第二组, type: select, proxies: [B] }\nrules: [MATCH,第一组]',
  }] });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  await browseGroup('第二组');
  const members = [...host.querySelectorAll<HTMLButtonElement>('.group-node')];
  expect(members).toHaveLength(1);
  expect(members[0].textContent).toContain('B');
  expect(members[0].disabled).toBe(true);
  expect(selectNode).not.toHaveBeenCalled();
});
