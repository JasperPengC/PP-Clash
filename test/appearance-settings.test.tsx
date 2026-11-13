// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { DEFAULT_SETTINGS, useApp } from '../src/store/app';
import { SettingsPage } from '../src/pages/Settings';

vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn().mockResolvedValue(undefined), listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});

it('三档选择即时生效并落盘，回到标准恢复默认；不重启、不推送代理配置、不增加路由版本', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(api.listBackups).mockResolvedValue([]);
  const applyConfig = vi.fn(); const restartKernel = vi.fn();
  useApp.setState({ settings: { ...DEFAULT_SETTINGS }, kernelPhase: 'running', sysProxyEnabled: true, profiles: [], applyConfig, restartKernel });
  const revision = useApp.getState().routeRevision;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SettingsPage)));
    const choose = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="文字大小"] button')].find(b => b.textContent === text)!;
    for (const [label, value] of [['较大', 'larger'], ['大', 'large'], ['标准', 'standard']]) {
      await act(async () => choose(label).click());
      expect(useApp.getState().settings.textSize).toBe(value);
      expect(document.documentElement.dataset.textSize).toBe(value);
      expect(choose(label).getAttribute('aria-pressed')).toBe('true');
      const saved = JSON.parse(vi.mocked(api.saveAppState).mock.lastCall![0]);
      expect(saved.settings.textSize).toBe(value);
    }
    expect(applyConfig).not.toHaveBeenCalled(); expect(restartKernel).not.toHaveBeenCalled();
    expect(api.setSystemProxy).not.toHaveBeenCalled(); expect(api.mihomo).not.toHaveBeenCalled();
    expect(useApp.getState().routeRevision).toBe(revision);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

function colorChannels(color: string) {
  const hex = color.match(/^#([\da-f]{6})$/i)?.[1];
  if (hex) return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  return color.match(/^rgba?\(([^)]+)\)$/)?.[1].split(/[\s,]+/).slice(0, 3).map(Number) ?? [];
}

function luminance(color: string) {
  const channels = colorChannels(color);
  expect(channels).toHaveLength(3);
  const linear = channels.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

it.each(['light', 'dark'])('%s 主题独立映射可读语义前景，上传使用橙色', theme => {
  const root = document.documentElement;
  const previousTheme = root.dataset.theme;
  const style = document.createElement('style');
  style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');
  const probe = document.createElement('span');
  probe.style.backgroundColor = 'var(--surface)';
  document.head.append(style); document.body.append(probe);
  try {
    root.dataset.theme = theme;
    const background = luminance(getComputedStyle(probe).backgroundColor);
    for (const role of ['text-primary', 'text-secondary', 'text-muted', 'accent-text', 'success', 'warning', 'danger', 'up', 'down']) {
      probe.style.color = `var(--${role})`;
      const foreground = luminance(getComputedStyle(probe).color);
      const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      expect(contrast, role).toBeGreaterThanOrEqual(4.5);
    }
    probe.style.color = 'var(--up)';
    const [red, green, blue] = colorChannels(getComputedStyle(probe).color);
    expect(red).toBeGreaterThan(green); expect(green).toBeGreaterThan(blue);
  } finally {
    style.remove(); probe.remove();
    if (previousTheme === undefined) delete root.dataset.theme;
    else root.dataset.theme = previousTheme;
  }
});
