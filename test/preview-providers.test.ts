// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
it('隔离设计预览为两类提供者返回真实接口形状，不触达原生内核', async () => {
  window.history.replaceState(null, '', '/?preview=connected');
  try {
    const { api, previewMode } = await import('../src/core/api');
    const { invoke } = await import('@tauri-apps/api/core');
    expect(previewMode).toBe(true);
    for (const path of ['/providers/rules', '/providers/proxies']) {
      expect(await api.mihomo('GET', path)).toEqual({ providers: {} });
    }
    expect(invoke).not.toHaveBeenCalled();
  } finally { window.history.replaceState(null, '', '/'); }
});
