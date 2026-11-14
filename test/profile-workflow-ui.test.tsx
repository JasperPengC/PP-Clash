// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfilesPage } from '../src/pages/Profiles';
import { useApp, type Profile } from '../src/store/app';
import { open } from '@tauri-apps/plugin-dialog';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
const initial = useApp.getInitialState();
let host: HTMLDivElement; let root: Root;
const activate = vi.fn(async (id: string) => { useApp.setState({ activeId: id }); });
const refresh = vi.fn().mockResolvedValue(true);
const update = vi.fn(initial.updateProfile);
const remove = vi.fn(initial.removeProfile);
const importUrl = vi.fn().mockResolvedValue(false);
const importFile = vi.fn().mockResolvedValue(false);
const raw = JSON.stringify({ proxies: [
  { name: 'Tokyo', type: 'socks5', server: 'fixture.invalid', port: 1080 },
  { name: 'Hong Kong', type: 'socks5', server: 'fixture.invalid', port: 1080 },
] });
const fixtures: Profile[] = [
  { id: 'one', name: 'Example Air', url: 'https://example.test/sub', raw, updatedAt: 1,
    userinfo: { upload: 1024, download: 1024, total: 8192, expire: 0 }, updateIntervalHours: 24 },
  { id: 'two', name: 'Backup', url: 'https://backup.test/sub', raw, updatedAt: 2,
    userinfo: null, updateIntervalHours: 12 },
  { id: 'file', name: 'Home Lab', sourceType: 'file', url: '/isolated/home.yaml', raw,
    updatedAt: 3, userinfo: null, updateIntervalHours: null, autoUpdateHours: 0 },
];
const card = (id: string) => host.querySelector<HTMLElement>(`[data-profile-id="${id}"]`)!;
const button = (name: string, scope: ParentNode = host) => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find(node => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === name);
  expect(found, `缺少按钮：${name}`).toBeDefined();
  return found!;
};
const click = async (name: string, scope?: ParentNode) => { await act(async () => button(name, scope).click()); };
const input = async (label: string, value: string) => {
  const node = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(node, `缺少输入框：${label}`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  refresh.mockResolvedValue(true); importUrl.mockResolvedValue(false); vi.mocked(open).mockResolvedValue(null);
  useApp.setState({ ...initial, activeId: 'one', activate, refreshProfile: refresh, updateProfile: update,
    removeProfile: remove, importProfile: importUrl, importProfileFile: importFile,
    profiles: fixtures.map(profile => ({ ...profile })) });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(ProfilesPage)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('当前订阅主卡呈现来源、节点、配额和连接状态，每卡有明确编辑入口', () => {
  const hero = host.querySelector<HTMLElement>('section[aria-label="当前订阅"]');
  expect(hero).not.toBeNull();
  expect(hero!.textContent).toContain('Example Air');
  expect(hero!.textContent).toContain('example.test');
  expect(hero!.textContent).toContain('2 个节点');
  expect(hero!.textContent).toContain('剩余');
  expect(hero!.textContent).toContain('未连接');
  expect(button('立即更新', hero!)).toBeDefined();
  for (const id of ['one', 'two', 'file']) expect(button(id === 'one' ? '编辑订阅' : '编辑', card(id))).toBeDefined();
  expect(card('two').textContent).toContain('暂无配额信息');
  expect(host.querySelector('[aria-label="删除订阅"]')).toBeNull();
  expect(host.querySelector('[aria-label="上移订阅"]')).toBeNull();
  expect(host.querySelector('.drag-handle')).toBeNull();
});

it('编辑、代理与更新动作不激活订阅，只有切换使用提交选择', async () => {
  await click('编辑', card('two'));
  await click('经代理更新', card('two'));
  await click('保存修改', card('two'));
  await click('更新订阅', card('two'));
  expect(refresh).toHaveBeenCalledWith('two');
  expect(update).toHaveBeenCalledWith('two', expect.objectContaining({ useProxy: true }));
  expect(activate).not.toHaveBeenCalled();
  await click('切换使用 Backup');
  expect(activate).toHaveBeenCalledWith('two');
  expect(host.querySelector('section[aria-label="当前订阅"]')!.textContent).toContain('Backup');
});

it('远程来源编辑先保存新URL，保留最后成功原文与更新时间', async () => {
  await click('编辑', card('two'));
  await input('订阅 URL', 'https://edited.test/new');
  expect(useApp.getState().profiles[1].url).toBe('https://backup.test/sub');
  await click('保存修改', card('two'));
  expect(useApp.getState().profiles[1]).toMatchObject({ url: 'https://edited.test/new', raw, updatedAt: 2 });
  expect(refresh).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
});

it('本地文件更换保存到原订阅而不重复导入，取消选择保留来源', async () => {
  await click('编辑', card('file'));
  expect(card('file').querySelector('[aria-label="订阅 URL"]')).toBeNull();
  await click('更换文件', card('file'));
  expect(useApp.getState().profiles[2].url).toBe('/isolated/home.yaml');
  vi.mocked(open).mockResolvedValueOnce('/isolated/replacement.yaml');
  await click('更换文件', card('file'));
  await click('保存修改', card('file'));
  expect(useApp.getState().profiles[2]).toMatchObject({ sourceType: 'file', url: '/isolated/replacement.yaml', raw, updatedAt: 3 });
  expect(useApp.getState().profiles).toHaveLength(3);
  expect(importFile).not.toHaveBeenCalled();
});

it('更新失败时主卡继续显示旧节点、时间与配额，失败原因就地可见', async () => {
  const before = useApp.getState().profiles[0];
  refresh.mockImplementationOnce(async () => {
    useApp.setState({ profileRefreshErrors: { one: '下载失败，已保留最后成功的订阅' } });
    return false;
  });
  await click('立即更新');
  expect(useApp.getState().profiles[0]).toBe(before);
  expect(card('one').textContent).toContain('2 个节点');
  expect(card('one').textContent).toContain('已保留最后成功');
  expect(card('one').textContent).toContain('剩余');
});

it('删除在编辑详情中二次确认，第一次不会移除订阅', async () => {
  await click('编辑', card('two'));
  await click('删除订阅', card('two'));
  expect(remove).not.toHaveBeenCalled();
  expect(useApp.getState().profiles).toHaveLength(3);
  await click('确认删除订阅', card('two'));
  expect(remove).toHaveBeenCalledWith('two');
  expect(useApp.getState().profiles).toHaveLength(2);
});

it('编辑模式提供拖拽与箭头排序，箭头保持当前使用且退出后隐藏管理控件', async () => {
  await click('编辑', card('two'));
  expect(host.querySelectorAll('.drag-handle')).toHaveLength(3);
  await click('上移订阅', card('two'));
  expect(useApp.getState().profiles.map(profile => profile.id)).toEqual(['two', 'one', 'file']);
  expect(useApp.getState().activeId).toBe('one');
  await click('取消编辑', card('two'));
  expect(host.querySelector('.drag-handle')).toBeNull();
  expect(host.querySelector('[aria-label="删除订阅"]')).toBeNull();
});

it('配置切换期间切换、更新和编辑提交入口都禁用', async () => {
  await click('编辑', card('two'));
  await act(async () => useApp.setState({ activatingProfile: true }));
  expect(button('切换使用 Backup').disabled).toBe(true);
  expect(button('立即更新').disabled).toBe(true);
  expect(button('全部更新').disabled).toBe(true);
  expect(button('保存修改', card('two')).disabled).toBe(true);
  await click('切换使用 Backup');
  expect(activate).not.toHaveBeenCalled();
});

it('统一新增入口的导入失败保留URL与代理输入', async () => {
  await click('添加订阅');
  await input('订阅链接', 'https://import.test/sub');
  await click('经代理导入订阅');
  await click('导入');
  expect(host.querySelector<HTMLInputElement>('[aria-label="订阅链接"]')!.value).toBe('https://import.test/sub');
  expect(button('经代理导入订阅').getAttribute('aria-checked')).toBe('true');
  expect(importUrl).toHaveBeenCalledWith('https://import.test/sub', true);
});

it('连接失败与运行状态未确认使用不同的状态文案', async () => {
  await act(async () => useApp.setState({ kernelPhase: 'failed', kernelError: '启动被拒绝' }));
  expect(card('one').textContent).toContain('连接失败');
  await act(async () => useApp.setState({ kernelPhase: 'running', kernelError: '运行配置回退未确认' }));
  expect(card('one').textContent).toContain('运行状态未确认');
});

it('Esc取消编辑丢弃草稿且焦点返回该卡片的编辑按钮', async () => {
  const edit = button('编辑', card('two'));
  await click('编辑', card('two'));
  await input('订阅 URL', 'https://unsaved.test/sub');
  await act(async () => host.querySelector('[aria-label="订阅 URL"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(useApp.getState().profiles[1].url).toBe('https://backup.test/sub');
  expect(card('two').querySelector('.sub-editor')).toBeNull();
  expect(document.activeElement).toBe(edit);
});
