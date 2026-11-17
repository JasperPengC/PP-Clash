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
const editLabel = (id: string) => `编辑订阅 ${id === 'one' ? 'Example Air' : id === 'two' ? 'Backup' : 'Home Lab'}`;
const button = (name: string, scope: ParentNode = document.body) => {
  const dialog = document.querySelector('[role="dialog"]');
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button'), ...(dialog && scope !== document.body ? dialog.querySelectorAll<HTMLButtonElement>('button') : [])]
    .find(node => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === name);
  expect(found, `缺少按钮：${name}`).toBeDefined();
  return found!;
};
const click = async (name: string, scope?: ParentNode) => { await act(async () => button(name, scope).click()); };
const input = async (label: string, value: string) => {
  const node = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(node, `缺少输入框：${label}`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  refresh.mockResolvedValue(true); importUrl.mockResolvedValue(false); importFile.mockResolvedValue(false); vi.mocked(open).mockResolvedValue(null);
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
  expect(button('更新订阅 Example Air', hero!)).toBeDefined();
  for (const id of ['one', 'two', 'file']) expect(button(editLabel(id), card(id))).toBeDefined();
  expect(card('two').textContent).toContain('暂无配额信息');
  expect(host.querySelector('[aria-label="删除订阅"]')).toBeNull();
  expect(host.querySelector('[aria-label="上移订阅"]')).toBeNull();
  expect(host.querySelector('.drag-handle')).toBeNull();
});

it('备用订阅更新时间与卡片操作按钮同行', () => {
  const updated = card('two').querySelector('.sub-card-updated');
  expect(updated?.parentElement?.classList.contains('sub-card-actions')).toBe(true);
  expect(card('two').querySelector('.sub-meta')?.textContent).not.toContain('更新于');
});

it('备用订阅有总配额时显示用量进度条，未知配额不显示虚构比例', async () => {
  await act(async () => useApp.setState(state => ({ profiles: state.profiles.map(profile => profile.id === 'two'
    ? { ...profile, userinfo: { upload: 10, download: 30, total: 100, expire: 0 } }
    : profile) })));
  expect(card('two').querySelector('.sub-progress .progress-fill')?.getAttribute('style')).toContain('width: 40%');
  expect(card('file').querySelector('.sub-progress')).toBeNull();
});

it('编辑、代理与更新动作不激活订阅，只有切换使用提交选择', async () => {
  await click(editLabel('two'), card('two'));
  await click('经代理更新', card('two'));
  await click('保存修改', card('two'));
  await click('更新订阅 Backup', card('two'));
  expect(refresh).toHaveBeenCalledWith('two');
  expect(update).toHaveBeenCalledWith('two', expect.objectContaining({ useProxy: true }));
  expect(activate).not.toHaveBeenCalled();
  await click('使用订阅 Backup');
  expect(activate).toHaveBeenCalledWith('two');
  expect(host.querySelector('section[aria-label="当前订阅"]')!.textContent).toContain('Backup');
});

it('远程来源编辑先保存新URL，保留最后成功原文与更新时间', async () => {
  await click(editLabel('two'), card('two'));
  await input('订阅 URL', 'https://edited.test/new');
  expect(useApp.getState().profiles[1].url).toBe('https://backup.test/sub');
  await click('保存修改', card('two'));
  expect(useApp.getState().profiles[1]).toMatchObject({ url: 'https://edited.test/new', raw, updatedAt: 2 });
  expect(refresh).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
});

it('编辑订阅时 Escape 先关闭下拉菜单，保留弹窗和未保存的草稿', async () => {
  await click(editLabel('two'), card('two'));
  await input('订阅 URL', 'https://edited.test/draft');
  await click('自动更新间隔');
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector<HTMLInputElement>('[aria-label="订阅 URL"]')!.value).toBe('https://edited.test/draft');
  expect(document.activeElement).toBe(button('自动更新间隔'));
});

it('本地文件更换保存到原订阅而不重复导入，取消选择保留来源', async () => {
  await click(editLabel('file'), card('file'));
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
  await click('更新订阅 Example Air');
  expect(useApp.getState().profiles[0]).toBe(before);
  expect(card('one').textContent).toContain('2 个节点');
  expect(card('one').textContent).toContain('已保留最后成功');
  expect(card('one').textContent).toContain('剩余');
});

it('删除在编辑详情中二次确认，第一次不会移除订阅', async () => {
  await click(editLabel('two'), card('two'));
  await click('删除订阅', card('two'));
  expect(remove).not.toHaveBeenCalled();
  expect(useApp.getState().profiles).toHaveLength(3);
  await click('确认删除订阅', card('two'));
  expect(remove).toHaveBeenCalledWith('two');
  expect(useApp.getState().profiles).toHaveLength(2);
});

it('拖拽排序独立于编辑弹窗，箭头排序保持当前使用', async () => {
  await click('订阅排序');
  expect(host.querySelectorAll('.drag-handle')).toHaveLength(3);
  await click(editLabel('two'), card('two'));
  expect(host.querySelectorAll('.drag-handle')).toHaveLength(0);
  await click('上移订阅', card('two'));
  expect(useApp.getState().profiles.map(profile => profile.id)).toEqual(['two', 'one', 'file']);
  expect(useApp.getState().activeId).toBe('one');
  await click('取消编辑', card('two'));
  expect(host.querySelector('.drag-handle')).toBeNull();
  expect(host.querySelector('[aria-label="删除订阅"]')).toBeNull();
});

it('配置切换期间切换、更新和编辑提交入口都禁用', async () => {
  await click(editLabel('two'), card('two'));
  await act(async () => useApp.setState({ activatingProfile: true }));
  expect(button('使用订阅 Backup').disabled).toBe(true);
  expect(button('更新订阅 Example Air').disabled).toBe(true);
  expect(button('全部更新').disabled).toBe(true);
  expect(button('保存修改', card('two')).disabled).toBe(true);
  await click('使用订阅 Backup');
  expect(activate).not.toHaveBeenCalled();
});

it('统一新增入口的导入失败保留URL与代理输入', async () => {
  await click('添加订阅');
  await input('订阅链接', 'https://import.test/sub');
  await click('经代理导入订阅');
  await click('导入');
  expect(document.querySelector<HTMLInputElement>('[aria-label="订阅链接"]')!.value).toBe('https://import.test/sub');
  expect(button('经代理导入订阅').getAttribute('aria-checked')).toBe('true');
  expect(importUrl).toHaveBeenCalledWith('https://import.test/sub', true);
});

it('添加订阅后直接聚焦链接，非法链接和重复链接不提交', async () => {
  await click('添加订阅');
  const field = document.querySelector<HTMLInputElement>('[aria-label="订阅链接"]')!;
  expect(document.activeElement).toBe(field);
  await input('订阅链接', 'not-a-url');
  await click('导入');
  expect(importUrl).not.toHaveBeenCalled();
  expect(document.querySelector('.import-error')?.textContent).toContain('http');
  await input('订阅链接', 'https://example.test/sub');
  await click('导入');
  expect(importUrl).not.toHaveBeenCalled();
  expect(document.querySelector('.import-error')?.textContent).toContain('已添加');
});

it('选择本地文件后先展示来源，确认导入时才添加，取消选择保留原来源', async () => {
  await click('添加订阅');
  await click('本地文件');
  vi.mocked(open).mockResolvedValueOnce('/isolated/new.yaml');
  await click('选择配置文件');
  expect(importFile).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>('[aria-label="待导入文件"]')?.value).toBe('/isolated/new.yaml');
  vi.mocked(open).mockResolvedValueOnce(null);
  await click('更换文件');
  expect(document.querySelector<HTMLInputElement>('[aria-label="待导入文件"]')?.value).toBe('/isolated/new.yaml');
  await click('导入文件');
  expect(importFile).toHaveBeenCalledExactlyOnceWith('/isolated/new.yaml');
  expect(document.querySelector('.import-error')).not.toBeNull();
});

it('导入进行中锁住输入和来源切换，失败后可在原输入上重试', async () => {
  let finish!: (value: boolean) => void;
  importUrl.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await click('添加订阅');
  await input('订阅链接', 'https://new.test/sub');
  await click('导入');
  expect(document.querySelector<HTMLInputElement>('[aria-label="订阅链接"]')?.disabled).toBe(true);
  expect(button('本地文件').disabled).toBe(true);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => finish(false));
  expect(document.querySelector<HTMLInputElement>('[aria-label="订阅链接"]')?.value).toBe('https://new.test/sub');
  expect(document.querySelector<HTMLInputElement>('[aria-label="订阅链接"]')?.disabled).toBe(false);
  expect(document.querySelector('.import-error')).not.toBeNull();
});

it('连接失败与运行状态未确认使用不同的状态文案', async () => {
  await act(async () => useApp.setState({ kernelPhase: 'failed', kernelError: '启动被拒绝' }));
  expect(card('one').textContent).toContain('连接失败');
  await act(async () => useApp.setState({ kernelPhase: 'running', kernelError: '运行配置回退未确认' }));
  expect(card('one').textContent).toContain('运行状态未确认');
});

it('Esc取消编辑丢弃草稿且焦点返回该卡片的编辑按钮', async () => {
  const edit = button(editLabel('two'), card('two'));
  await click(editLabel('two'), card('two'));
  await input('订阅 URL', 'https://unsaved.test/sub');
  await act(async () => document.querySelector('[aria-label="订阅 URL"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(useApp.getState().profiles[1].url).toBe('https://backup.test/sub');
  expect(card('two').querySelector('.sub-editor')).toBeNull();
  expect(document.activeElement).toBe(edit);
});

it('添加订阅使用独立弹窗，Esc关闭并把焦点交还入口', async () => {
  const trigger = button('添加订阅');
  trigger.focus();
  await click('添加订阅');
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.contains(document.activeElement)).toBe(true);
  expect(host.querySelector('[aria-label="订阅链接"]')).toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('首次导入通过空状态主动打开，关闭弹窗后仍能再次添加', async () => {
  await act(async () => useApp.setState({ profiles: [], activeId: null }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click('添加订阅');
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="取消添加订阅"]')!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button('添加订阅').disabled).toBe(false);
});

it('订阅编辑在弹窗内进行，关闭后草稿丢弃且卡片不展开', async () => {
  await click(editLabel('two'), card('two'));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(card('two').querySelector('.sub-editor')).toBeNull();
  await input('订阅 URL', 'https://draft.invalid/sub');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(useApp.getState().profiles[1].url).toBe('https://backup.test/sub');
  expect(document.activeElement).toBe(button(editLabel('two'),card('two')));
});
