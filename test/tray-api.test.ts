// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.clearAllMocks();
  vi.resetModules();
});

it('托盘桥接完整传递包含分隔符的结构化节点动作，其他动作保留字符串', async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.resetModules();
  const { api } = await import('../src/core/api');
  await api.trayAction('node', { group: '任意 | 组名 / "工作"', node: '节点 | 美国 / A' });
  expect(invoke).toHaveBeenLastCalledWith('tray_action', {
    action: 'node', value: { group: '任意 | 组名 / "工作"', node: '节点 | 美国 / A' },
  });
  await api.trayAction('mode', 'global');
  expect(invoke).toHaveBeenLastCalledWith('tray_action', { action: 'mode', value: 'global' });
  await api.trayAction('tun');
  expect(invoke).toHaveBeenLastCalledWith('tray_action', { action: 'tun', value: null });
});

it('主窗口传入配置顺序，桥接不排序或拆解任意策略名称', async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.resetModules();
  const { api } = await import('../src/core/api');
  await api.setTrayFlags(false, false, 7890, 'rule', true, false, '', 'Z | 工作', ['Z | 工作', 'A']);
  expect(invoke).toHaveBeenLastCalledWith('set_tray_flags', {
    tunEnabled: false, sysProxyEnabled: false, mixedPort: 7890, mode: 'rule', showSpeed: true,
    hideDock: false, controllerSecret: '', primaryGroup: 'Z | 工作', groupOrder: ['Z | 工作', 'A'],
  });
});
