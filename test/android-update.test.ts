// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';

vi.mock('../src/core/platform', () => ({ isAndroid: true, isWindows: false, isLinux: false }));
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: { ...actual.api,
    checkGithubUpdate: vi.fn(), downloadAppUpdate: vi.fn(), openDownloadedUpdate: vi.fn(),
  } };
});
const initial = useApp.getInitialState();
const offer = { version: '0.3.0', url: 'https://github.com/example/app/releases/download/v0.3.0/app.apk', sha256: 'a'.repeat(64) };
beforeEach(() => { vi.resetAllMocks(); useApp.setState({ ...initial, persistenceFrozen: true, updateInfo: offer }); });
afterEach(() => useApp.setState(initial));

it('重新检查失败后清除过期的更新结果，保留错误供重试', async () => {
  vi.mocked(api.checkGithubUpdate).mockRejectedValue(new Error('网络已断开'));
  await useApp.getState().checkUpdate(true);
  expect(useApp.getState()).toMatchObject({ checkingUpdate: false, updateInfo: null, updateError: '网络已断开' });
});

it('安装权限拒绝后恢复按钮，并提示安装环节失败', async () => {
  vi.mocked(api.downloadAppUpdate).mockResolvedValue('/cache/updates/update.apk');
  vi.mocked(api.openDownloadedUpdate).mockRejectedValue(new Error('未允许安装应用'));
  await useApp.getState().downloadUpdate();
  expect(useApp.getState().downloadingUpdate).toBe(false);
  expect(useApp.getState().updateInfo).toEqual(offer);
  expect(useApp.getState().toast?.text).toBe('无法安装更新：未允许安装应用');
});
