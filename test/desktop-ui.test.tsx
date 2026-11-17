// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MiniSwitch, Pill, Segmented, Select, Toggle } from '../src/components/ui';
import * as sharedUi from '../src/components/ui';
import { readFileSync } from 'node:fs';
import { RouteDiagnosticsPanel } from '../src/components/RouteDiagnosticsPanel';

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const key = async (target: Element, value: string) => act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));

it('分段组暴露共享类名与即时按下状态，禁用后不能修改选项', async () => {
  const change = vi.fn();
  const options = [{ value: 'rule', label: '规则' }, { value: 'global', label: '全局' }];
  await act(async () => root.render(createElement(Segmented, { value: 'rule', options, onChange: change, ariaLabel: '路由模式' })));
  const group = host.querySelector('[role="group"][aria-label="路由模式"]')!;
  expect(group.classList.contains('segmented')).toBe(true);
  expect(group.querySelector('[aria-pressed="true"]')?.textContent).toBe('规则');
  await act(async () => (group.querySelectorAll('button')[1] as HTMLButtonElement).click());
  expect(change).toHaveBeenCalledExactlyOnceWith('global');
  await act(async () => root.render(createElement(Segmented, { value: 'global', options, onChange: change, ariaLabel: '路由模式', disabled: true })));
  expect(group.querySelector('[aria-pressed="true"]')?.textContent).toBe('全局');
  await act(async () => (group.querySelector('button') as HTMLButtonElement).click());
  expect(change).toHaveBeenCalledTimes(1);
});

it('状态胶囊保留既有语义色并允许描述状态', async () => {
  await act(async () => root.render(createElement(Pill, { tone: 'ok', 'aria-label': '内核运行正常', children: '运行中' })));
  const pill = host.querySelector('.pill')!;
  expect(pill.classList.contains('pill-ok')).toBe(true);
  expect(pill.classList.contains('ok')).toBe(true);
  expect(pill.getAttribute('aria-label')).toBe('内核运行正常');
});

it('搜索是真实命名输入，组合输入中的 Escape 保留草稿，清除后焦点仍在输入框', async () => {
  const change = vi.fn();
  const SearchField = sharedUi.SearchField;
  await act(async () => root.render(SearchField ? createElement(SearchField, { value: '东京', onChange: change, ariaLabel: '搜索节点' }) : null));
  const input = host.querySelector<HTMLInputElement>('input[type="search"]');
  expect(input).not.toBeNull();
  expect(input?.getAttribute('aria-label')).toBe('搜索节点');
  input!.focus();
  await act(async () => input!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await key(input!, 'Escape');
  expect(change).not.toHaveBeenCalled();
  await act(async () => input!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  const clear = host.querySelector<HTMLButtonElement>('button[aria-label="清除搜索节点"]');
  expect(clear).not.toBeNull();
  await act(async () => clear!.click());
  expect(change).toHaveBeenCalledExactlyOnceWith('');
  expect(document.activeElement).toBe(input);
});

it('选择器互斥，键盘打开第二个时第一个立即退出可访问树', async () => {
  const options = [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }];
  await act(async () => root.render(createElement('div', {},
    createElement(Select, { value: 'a', options, onChange: vi.fn(), ariaLabel: '第一选项' }),
    createElement(Select, { value: 'b', options, onChange: vi.fn(), ariaLabel: '第二选项' }))));
  const triggers = host.querySelectorAll<HTMLButtonElement>('.select-btn');
  triggers[0].focus(); await key(triggers[0], 'ArrowDown');
  expect(document.querySelectorAll('[role="listbox"]')).toHaveLength(1);
  await act(async () => { triggers[1].focus(); });
  await key(triggers[1], 'ArrowDown');
  expect(document.querySelectorAll('[role="listbox"]')).toHaveLength(1);
  expect(document.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('第二选项');
});

it('共享控件、数据行和内容卡从令牌获得标准与紧凑尺度', async () => {
  const style = document.createElement('style');
  style.textContent = ['tokens', 'theme', 'legacy-components', 'legacy-pages', 'legacy-platform', 'legacy-compatibility', 'desktop', 'segmented', 'motion'].map(name =>
    readFileSync(`src/styles/${name}.css`, 'utf8')).join('\n');
  document.head.append(style);
  document.documentElement.dataset.theme = 'light';
  try {
    await act(async () => root.render(createElement('div', {},
      createElement('button', { className: 'btn' }, '标准'),
      createElement('button', { className: 'btn btn-sm' }, '紧凑'),
      createElement('button', { className: 'icon-btn', 'aria-label': '刷新' }),
      createElement('input', { className: 'input', 'aria-label': '输入' }),
      createElement(Segmented, { value: 'a', options: [{ value: 'a', label: '甲' }], onChange: vi.fn(), ariaLabel: '模式' }),
      createElement(Toggle, { on: true, onChange: vi.fn(), label: '系统代理' }),
      createElement(MiniSwitch, { on: true, onChange: vi.fn(), label: '启用规则' }),
      createElement(Pill, { children: '等待' }),
      createElement('div', { className: 'data-row' }, '数据'),
      createElement('div', { className: 'surface-card' }, '卡片'))));
    expect(getComputedStyle(host.querySelector('.btn')!).height).toBe('32px');
    expect(getComputedStyle(host.querySelector('.btn-sm')!).height).toBe('28px');
    expect(getComputedStyle(host.querySelector('.icon-btn')!).height).toBe('32px');
    expect(getComputedStyle(host.querySelector('.input')!).height).toBe('32px');
    expect(getComputedStyle(host.querySelector('[role="group"]')!).height).toBe('32px');
    expect(getComputedStyle(host.querySelector('.pill')!).height).toBe('28px');
    expect(getComputedStyle(host.querySelector('.data-row')!).minHeight).toBe('48px');
    expect(getComputedStyle(host.querySelector('.surface-card')!).borderRadius).toBe('16px');
    expect(getComputedStyle(host.querySelector('.toggle')!).width).toBe('40px');
    expect(getComputedStyle(host.querySelector('.toggle')!).height).toBe('22px');
    const miniSwitch = host.querySelector('.mini-switch')!;
    const thumb = miniSwitch.querySelector('span')!;
    expect.soft(getComputedStyle(miniSwitch).width).toBe('40px');
    expect.soft(getComputedStyle(miniSwitch).height).toBe('22px');
    expect.soft(getComputedStyle(thumb).width).toBe('18px');
    expect.soft(getComputedStyle(thumb).height).toBe('18px');
  } finally { style.remove(); delete document.documentElement.dataset.theme; }
});

it('MiniSwitch 保留名称和 checked 状态，禁用时不更新且点击不触发外层操作', async () => {
  const change = vi.fn();
  const outer = vi.fn();
  const renderSwitch = async (on: boolean, disabled = false) => act(async () => root.render(
    createElement('div', { onClick: outer }, createElement(MiniSwitch, { on, disabled, onChange: change, label: '启用覆写' }))));
  await renderSwitch(false);
  const control = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(control.getAttribute('aria-label')).toBe('启用覆写');
  expect(control.getAttribute('aria-checked')).toBe('false');
  await act(async () => control.click());
  expect(change).toHaveBeenCalledExactlyOnceWith(true);
  expect(outer).not.toHaveBeenCalled();
  await renderSwitch(true, true);
  expect(control.getAttribute('aria-checked')).toBe('true');
  expect(control.disabled).toBe(true);
  await act(async () => control.click());
  expect(change).toHaveBeenCalledTimes(1);
});

it('下拉可用方向键选择、Escape退出，并将焦点还给触发器', async () => {
  const change = vi.fn();
  await act(async () => root.render(createElement(Select, { value: 'a', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }], onChange: change, ariaLabel: '测试选项' })));
  const trigger = host.querySelector('button')!; trigger.focus();
  await key(trigger, 'ArrowDown');
  expect(document.activeElement?.textContent).toContain('甲');
  await key(document.activeElement!, 'ArrowDown');
  expect(document.activeElement?.textContent).toContain('乙');
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(change).toHaveBeenCalledWith('b');
  expect(document.activeElement).toBe(trigger);
  await key(trigger, 'ArrowDown'); await key(document.activeElement!, 'Escape');
  expect(document.querySelector('[role=listbox]')).toBeNull(); expect(document.activeElement).toBe(trigger);
});

const result = () => ({ egress: null, egressLoading: false, egressCountry: null, serviceMap: {}, servicesLoading: false,
  servicesAt: null, ipQuality: null, ipQualityLoading: false, ipQualityError: null, ipQualityAt: null,
  leakRows: [], leakPhase: 'idle' as const, runServiceProbe: vi.fn(), loadIpQuality: vi.fn(), runLeakCheck: vi.fn() });

it('诊断摘要区分等待与通过，展开详情不发送新诊断', async () => {
  const diagnostics = result();
  await act(async () => root.render(createElement(RouteDiagnosticsPanel, { connected: true, diagnostics })));
  expect(host.textContent).toContain('等待出口稳定');
  expect(host.textContent).not.toContain('全部通过');
  const toggle = host.querySelector('[aria-expanded]') as HTMLButtonElement;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await act(async () => toggle.click());
  expect(host.textContent).toContain('服务连通'); expect(diagnostics.runServiceProbe).not.toHaveBeenCalled();
});

it('折叠时仍提示故障，任何诊断未完成时不允许重复刷新', async () => {
  const diagnostics = { ...result(), serviceMap: { google: { ok: false, latency_ms: null } }, servicesAt: 100,
    ipQualityLoading: true };
  await act(async () => root.render(createElement(RouteDiagnosticsPanel, { connected: true, diagnostics })));
  expect(host.textContent).toContain('1 项服务不可达');
  expect(host.querySelector<HTMLButtonElement>('[aria-label="刷新出口诊断"]')?.disabled).toBe(true);
});


it('下拉支持 Home/End/Tab，并阻止门户中的按键和点击触发外层操作', async () => {
  const outer = vi.fn(); const change = vi.fn();
  await act(async () => root.render(createElement('div', { onClick: outer, onKeyDown: outer },
    createElement(Select, { value: 'b', options: [{ value: 'a', label: '首项' }, { value: 'b', label: '末项' }], onChange: change, ariaLabel: '选择' }))));
  const trigger = host.querySelector('button')!;
  await key(trigger, 'ArrowDown'); outer.mockClear();
  await key(document.activeElement!, 'Home'); expect(document.activeElement?.textContent).toContain('首项');
  await key(document.activeElement!, 'End'); expect(document.activeElement?.textContent).toContain('末项');
  await key(document.activeElement!, 'Tab');
  expect(document.querySelector('[role=listbox]')).toBeNull(); expect(outer).not.toHaveBeenCalled();
  await key(trigger, 'ArrowDown'); outer.mockClear();
  await act(async () => (document.activeElement as HTMLElement).click());
  expect(change).toHaveBeenCalledWith('b'); expect(outer).not.toHaveBeenCalled();
});

it('未验证的泄漏结果和空的完成列表不会报告未发现泄漏', async () => {
  const diagnostics = { ...result(), leakPhase: 'done' as const };
  await act(async () => root.render(createElement(RouteDiagnosticsPanel, { connected: true, diagnostics })));
  expect(host.textContent).toContain('尚未完成'); expect(host.textContent).not.toContain('未发现泄漏');
  await act(async () => root.render(createElement(RouteDiagnosticsPanel, { connected: true, diagnostics: { ...diagnostics, leakRows: [{ id: 'dns', label: 'DNS', status: 'info', text: '未确认' }] } })));
  expect(host.textContent).toContain('有项目未确认'); expect(host.textContent).not.toContain('未发现泄漏');
});

it('服务检测器错误显示原因与未验证，不计作网站不可达', async () => {
  const diagnostics = { ...result(), servicesAt: 100, serviceMap: {
    github: { ok: false, latency_ms: null, status: 'error' as const, detail: '控制器认证失败' },
    google: { ok: true, latency_ms: 12, status: 'reachable' as const },
  } };
  await act(async () => root.render(createElement(RouteDiagnosticsPanel, { connected: true, diagnostics })));
  expect(host.textContent).toContain('1 项未验证');
  expect(host.textContent).not.toContain('服务不可达');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
  expect(host.textContent).toContain('检测异常');
  expect(host.textContent).toContain('控制器认证失败');
});

it('诊断只在对应文字标记状态颜色，不显示总关注标签；刷新保留图标按钮与操作', async () => {
  const diagnostics = { ...result(), servicesAt: 100, leakPhase: 'done' as const,
    serviceMap: Object.fromEntries(['google', 'youtube', 'github', 'openai', 'anthropic'].map(id => [id, { ok: true, latency_ms: 12 }])),
    ipQuality: { ip: '1.2.3.4', country: null, region: null, city: null, isp: null, org: null, asn: null,
      hosting: true, proxy: true, mobile: false, kind: '代理出口', risk: '高', score: 32 },
    leakRows: [{ id: 'webrtc', label: 'WebRTC 候选', status: 'ok' as const, text: '本应用未发现公网本地候选' }],
  };
  await act(async () => root.render(createElement(RouteDiagnosticsPanel, { connected: true, diagnostics })));
  expect(host.querySelector('.diagnostics-heading .pill')).toBeNull();
  expect(host.textContent).not.toContain('有项目需要关注');
  const summaries = host.querySelectorAll('.diagnostics-summary strong');
  expect(summaries[0].classList.contains('diagnostic-status-ok')).toBe(true);
  expect(summaries[1].classList.contains('diagnostic-status-warn')).toBe(true);
  expect(summaries[2].classList.contains('diagnostic-status-ok')).toBe(true);
  const refresh = host.querySelector<HTMLButtonElement>('[aria-label="刷新出口诊断"]')!;
  expect(refresh.classList.contains('icon-btn')).toBe(true);
  expect(refresh.textContent).toBe('');
  await act(async () => refresh.click()); expect(diagnostics.runServiceProbe).toHaveBeenCalledOnce();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
  expect(host.textContent).toContain('参考评分'); expect(host.textContent).not.toContain('纯净度');
  expect(host.querySelector('.diagnostic-leaks .diagnostic-status-ok')?.textContent).toContain('本应用');
});

it('明确失败与未知结果使用各自颜色，等待检测不呈现成功', async () => {
  const diagnostics = { ...result(), servicesAt: 100, leakPhase: 'done' as const,
    serviceMap: { google: { ok: false, latency_ms: null } }, ipQualityError: '查询失败',
    leakRows: [{ id: 'webrtc', label: 'WebRTC', status: 'info' as const, text: '不支持检测' }],
  };
  await act(async () => root.render(createElement(RouteDiagnosticsPanel, { connected: true, diagnostics })));
  let summaries = host.querySelectorAll('.diagnostics-summary strong');
  expect(summaries[0].classList.contains('diagnostic-status-bad')).toBe(true);
  expect(summaries[1].classList.contains('diagnostic-status-bad')).toBe(true);
  expect(summaries[2].classList.contains('diagnostic-status-warn')).toBe(true);
  await act(async () => root.render(createElement(RouteDiagnosticsPanel, { connected: true, diagnostics: result() })));
  summaries = host.querySelectorAll('.diagnostics-summary strong');
  expect([...summaries].every(el => !el.classList.contains('diagnostic-status-ok'))).toBe(true);
  expect(host.textContent).toContain('等待出口稳定');
});
