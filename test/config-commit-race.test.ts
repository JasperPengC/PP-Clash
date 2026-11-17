// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';
vi.mock('../src/core/api', async original => {
  const actual = await original<any>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});
vi.mock('../src/core/generator', async original => {
  const actual = await original<any>();
  return { ...actual, generateConfig: vi.fn(async (_raw, _policy, runtime) => ({
    config: JSON.stringify({ 'mixed-port': runtime.mixedPort }), audit: [],
    stats: { marker: runtime.mixedPort }, routing: { primary: String(runtime.mixedPort) },
  })) };
});
it('已发出的提交过期且后续校验失败时，正式文件和内存版本必须一致', async () => {
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, activeId: 'p', configPath: '/isolated/config.yaml', dataDir: '/isolated',
    profiles: [{ id: 'p', name: 'mock', url: '', raw: 'proxies: []', updatedAt: 0, userinfo: null, updateIntervalHours: null }],
    stats: { marker: 7890 } as any, settings: { ...initial.settings, mixedPort: 7891 } });
  let disk = JSON.stringify({ 'mixed-port': 7890 });
  let sequence = 0;
  const candidates = new Map<string, string>();
  vi.mocked(api.prepareConfig).mockImplementation(async content => {
    const path = `/isolated/candidate-${++sequence}.yaml`; candidates.set(path, content); return path;
  });
  vi.mocked(api.validateConfig).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('invalid newest config'));
  let finish!: () => void;
  vi.mocked(api.commitConfig).mockImplementationOnce(async path => {
    await new Promise<void>(r => { finish = r; });
    disk = candidates.get(path)!;
    return '/isolated/config.yaml';
  });
  const previous = disk;
  vi.mocked(api.finishConfig).mockImplementation(async (_path, rollback) => { if (rollback) disk = previous; });
  const older = useApp.getState().applyConfig();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  useApp.getState().updateSettings({ mixedPort: 7892 });
  expect(await useApp.getState().applyConfig()).toBe(false);
  finish();
  expect(await older).toBe(false);
  expect(api.finishConfig).toHaveBeenCalledWith('/isolated/candidate-1.yaml', true);
  expect({ diskPort: JSON.parse(disk)['mixed-port'], publishedPort: (useApp.getState().stats as any).marker }).toEqual({ diskPort: 7890, publishedPort: 7890 });
});
