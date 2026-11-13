// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => native);
vi.mock('../src/core/api', () => ({ isTauri: true }));

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear();
  native.listen.mockResolvedValue(vi.fn()); native.emit.mockResolvedValue(undefined);
});
afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks(); });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

it('首帧恢复本地选择，非法值回退标准；选择立即应用并发布给其他窗口', async () => {
  localStorage.setItem('ppclash.text-size', 'larger');
  const size = await import('../src/store/text-size');
  stop = size.initTextSize();
  expect(document.documentElement.dataset.textSize).toBe('larger');
  size.setTextSize('large');
  expect(document.documentElement.dataset.textSize).toBe('large');
  expect(localStorage.getItem('ppclash.text-size')).toBe('large');
  expect(native.emit).toHaveBeenCalledWith('appearance://text-size', 'large');
  expect(size.normalizeTextSize('unexpected')).toBe('standard');
});

it('托盘监听注册后只读一次磁盘，受限 localStorage 不妨碍显示与同步', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('denied'); });
  const size = await import('../src/store/text-size');
  const read = vi.fn().mockResolvedValue('large');
  stop = size.initTextSize(read); await tick();
  expect(read).toHaveBeenCalledTimes(1);
  expect(document.documentElement.dataset.textSize).toBe('large');
  native.listen.mock.calls[0][1]({ payload: 'larger' });
  expect(document.documentElement.dataset.textSize).toBe('larger');
  expect(native.emit).toHaveBeenCalledWith('appearance://request-text-size');
  expect(native.emit).not.toHaveBeenCalledWith('appearance://text-size', expect.anything());
});

it('新的窗口事件或用户选择不会被迟到的磁盘恢复覆盖', async () => {
  const size = await import('../src/store/text-size');
  const disk = deferred<string>();
  stop = size.initTextSize(() => disk.promise); await tick();
  native.listen.mock.calls[0][1]({ payload: 'large' });
  disk.resolve('standard'); await tick();
  expect(document.documentElement.dataset.textSize).toBe('large');
  const revision = size.textSizeRevision();
  size.setTextSize('larger');
  expect(size.restoreTextSize('standard', revision)).toBe('larger');
});

it('忽略非法跨窗值，storage 同步不回发；销毁后迟到的监听/读取均不生效', async () => {
  const size = await import('../src/store/text-size');
  const listener = deferred<() => void>(); const unlisten = vi.fn(); const read = vi.fn();
  native.listen.mockReturnValue(listener.promise);
  stop = size.initTextSize(read);
  window.dispatchEvent(new StorageEvent('storage', { key: 'ppclash.text-size', newValue: 'large' }));
  expect(document.documentElement.dataset.textSize).toBe('large');
  native.listen.mock.calls[0][1]({ payload: 'invalid' });
  expect(document.documentElement.dataset.textSize).toBe('large');
  stop(); listener.resolve(unlisten); await tick();
  expect(unlisten).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
  window.dispatchEvent(new StorageEvent('storage', { key: 'ppclash.text-size', newValue: 'standard' }));
  expect(document.documentElement.dataset.textSize).toBe('large');
  expect(native.emit).not.toHaveBeenCalled();
});

it('监听/读取失败保留本地偏好，无未处理的拒绝', async () => {
  localStorage.setItem('ppclash.text-size', 'larger');
  const size = await import('../src/store/text-size');
  native.listen.mockRejectedValue(Error('unavailable'));
  const read = vi.fn().mockRejectedValue(Error('unavailable'));
  stop = size.initTextSize(read); await tick();
  expect(read).toHaveBeenCalledOnce();
  expect(document.documentElement.dataset.textSize).toBe('larger');
});

it('主窗口响应新托盘的请求，读取端不把旧磁盘值写回本地缓存', async () => {
  const size = await import('../src/store/text-size');
  stop = size.initTextSize(); await tick(); size.setTextSize('large');
  native.emit.mockClear();
  native.listen.mock.calls.find(([name]) => name === 'appearance://request-text-size')![1]({});
  expect(native.emit).toHaveBeenCalledWith('appearance://text-size', 'large');
  stop(); stop = size.initTextSize(async () => 'standard'); await tick();
  expect(localStorage.getItem('ppclash.text-size')).toBe('large');
  native.listen.mock.calls.filter(([name]) => name === 'appearance://text-size').at(-1)![1]({ payload: 'large' });
  expect(document.documentElement.dataset.textSize).toBe('large');
});

it('主窗口自己的广播回声不阻止启动恢复，也不回滚较新的选择', async () => {
  const size = await import('../src/store/text-size');
  stop = size.initTextSize(); await tick();
  const revision = size.textSizeRevision();
  const receive = native.listen.mock.calls.find(([name]) => name === 'appearance://text-size')![1];
  receive({ payload: 'standard' });
  expect(size.restoreTextSize('larger', revision)).toBe('larger');
  size.setTextSize('large'); receive({ payload: 'larger' });
  expect(document.documentElement.dataset.textSize).toBe('large');
});

const tokensCss = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');
const typographyCss = readFileSync(resolve(process.cwd(), 'src/styles/typography.css'), 'utf8');

function withTypography(run: (root: HTMLElement, probe: HTMLElement) => void) {
  const root = document.documentElement;
  const previousSize = root.dataset.textSize;
  const style = document.createElement('style');
  style.textContent = `${tokensCss}\n${typographyCss}`;
  const probe = document.createElement('span');
  document.head.append(style); document.body.append(probe);
  try { run(root, probe); }
  finally {
    style.remove(); probe.remove();
    if (previousSize === undefined) delete root.dataset.textSize;
    else root.dataset.textSize = previousSize;
  }
}

it('共享桌面令牌提供统一控件、行、图标、开关和圆角尺寸', () => {
  expect(tokensCss).toMatch(/--control-height:\s*32px/);
  expect(tokensCss).toMatch(/--row-height:\s*48px/);
  withTypography(root => {
    const computed = getComputedStyle(root);
    for (const [role, expected] of [
      ['--control-height', '32px'], ['--control-height-compact', '28px'],
      ['--row-height', '48px'], ['--nav-row-height', '36px'],
      ['--switch-width', '40px'], ['--switch-height', '22px'],
      ['--icon-sm', '15px'], ['--icon-md', '16px'],
      ['--radius-control', '10px'], ['--radius-card', '16px'], ['--radius-pill', '999px'],
    ]) expect(computed.getPropertyValue(role), role).toBe(expected);
  });
});

it.each([
  ['standard', 21, 13, 12, 11],
  ['larger', 22, 14, 13, 12],
  ['large', 23, 15, 14, 13],
] as const)('%s 字号提供完整角色，功能文字不小于元信息字号', (mode, page, body, label, meta) => {
  expect(tokensCss).toMatch(/--type-page:/);
  expect(tokensCss).toMatch(/--type-body:/);
  expect(tokensCss).toMatch(/--type-meta:/);
  withTypography((root, probe) => {
    root.dataset.textSize = mode;
    const computed = getComputedStyle(root);
    const fontSize = (role: string) => {
      probe.style.fontSize = `var(--type-${role})`;
      return parseFloat(getComputedStyle(probe).fontSize);
    };
    for (const role of ['page', 'section', 'body', 'label', 'control', 'meta', 'hint', 'micro', 'metric', 'gauge', 'subtitle']) {
      expect(computed.getPropertyValue(`--type-${role}`), role).not.toBe('');
      expect(fontSize(role), role).toBeGreaterThanOrEqual(meta);
    }
    expect(fontSize('page')).toBe(page);
    expect(fontSize('body')).toBe(body);
    expect(fontSize('label')).toBe(label);
    expect(fontSize('meta')).toBe(meta);
    probe.style.removeProperty('font-size');
    probe.className = 'page-title';
    expect(getComputedStyle(probe).fontWeight).toBe('700');
    probe.className = 'field-label';
    expect(getComputedStyle(probe).fontWeight).toBe('600');
  });
});
