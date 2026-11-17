// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';
import { runJsOverride } from '../src/core/js-sandbox';
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});
vi.mock('../src/core/js-sandbox', () => ({ runJsOverride:vi.fn() }));
it('迟到的旧配置不能覆盖已完成的新端口设置', async () => {
  let finish!: () => void;
  vi.mocked(runJsOverride).mockImplementationOnce(config => new Promise(r => finish=()=>r(config))).mockImplementation(async config=>config);
  const writes: Record<string, unknown>[]=[];
  const candidates = new Map<string, Record<string, unknown>>();
  vi.mocked(api.prepareConfig).mockImplementation(async config => {
    const path = `/isolated/candidate-${candidates.size}.yaml`; candidates.set(path, JSON.parse(config)); return path;
  });
  vi.mocked(api.commitConfig).mockImplementation(async path => { writes.push(candidates.get(path)!); return '/isolated/config.yaml'; });
  const initial=useApp.getInitialState();
  useApp.setState({...initial,activeId:'p',profiles:[{id:'p',name:'mock',url:'',raw:'proxies: []\nproxy-groups: []\nrules: []',sourceType:'file',updatedAt:0,userinfo:null,updateIntervalHours:null}],settings:{...initial.settings,mixedPort:7890,overrides:[{id:'js',name:'async',enabled:true,mode:'js',text:'function main(config) { return config; }'}]}});
  const older=useApp.getState().applyConfig();
  expect(finish).toBeTypeOf('function');
  useApp.getState().updateSettings({mixedPort:7891});
  expect(await useApp.getState().applyConfig()).toBe(true);
  finish(); expect(await older).toBe(false);
  expect(writes.map(x=>x['mixed-port'])).toEqual([7891]);
  expect(useApp.getState().settings.mixedPort).toBe(7891);
});

it('校验失败不覆盖上一份可启动配置且清理候选', async () => {
  vi.mocked(runJsOverride).mockImplementation(async config => config);
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, activeId: 'p', configPath: '/isolated/config.yaml', dataDir: '/isolated',
    profiles: [{ id: 'p', name: 'mock', url: '', raw: 'proxies: []\nproxy-groups: []\nrules: []', updatedAt: 0, userinfo: null, updateIntervalHours: null }] });
  const commitCount = vi.mocked(api.commitConfig).mock.calls.length;
  vi.mocked(api.prepareConfig).mockResolvedValueOnce('/isolated/rejected.yaml');
  vi.mocked(api.validateConfig).mockRejectedValueOnce(new Error('invalid config'));
  expect(await useApp.getState().applyConfig()).toBe(false);
  expect(api.commitConfig).toHaveBeenCalledTimes(commitCount);
  expect(api.discardConfig).toHaveBeenCalledWith('/isolated/rejected.yaml');
  expect(useApp.getState().configPath).toBe('/isolated/config.yaml');
  expect(useApp.getState().busy).toBe(false);
});

it('新配置完成时旧生成仍在途，忙状态保持到所有候选结束', async () => {
  let finish!: () => void;
  vi.mocked(runJsOverride).mockImplementationOnce(config => new Promise(r => { finish = () => r(config); })).mockImplementation(async config => config);
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, activeId: 'p', profiles: [{ id: 'p', name: 'mock', url: '', raw: 'proxies: []\nproxy-groups: []\nrules: []', updatedAt: 0, userinfo: null, updateIntervalHours: null }],
    settings: { ...initial.settings, overrides: [{ id: 'js', name: 'async', enabled: true, mode: 'js', text: 'function main(config) { return config; }' }] } });
  const older = useApp.getState().applyConfig();
  expect(await useApp.getState().applyConfig()).toBe(true);
  expect(useApp.getState().busy).toBe(true);
  finish(); expect(await older).toBe(false);
  expect(useApp.getState().busy).toBe(false);
});

it('旧候选校验晚于新候选提交时丢弃，不能把旧内容标成最新已校验', async () => {
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, activeId: 'p', profiles: [{ id: 'p', name: 'mock', url: '', raw: 'proxies: []\nproxy-groups: []\nrules: []', updatedAt: 0, userinfo: null, updateIntervalHours: null }] });
  let finish!: () => void;
  let sequence = 0;
  const pending = new Map<string, string>();
  const committed: number[] = [];
  vi.mocked(api.prepareConfig).mockImplementation(async content => {
    const path = `/isolated/version-${++sequence}.yaml`; pending.set(path, content); return path;
  });
  vi.mocked(api.validateConfig).mockImplementationOnce(() => new Promise(r => { finish = r; })).mockResolvedValue(undefined);
  vi.mocked(api.commitConfig).mockImplementation(async path => { committed.push(JSON.parse(pending.get(path)!)['mixed-port']); return '/isolated/config.yaml'; });
  const older = useApp.getState().applyConfig();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  useApp.getState().updateSettings({ mixedPort: 7891 });
  expect(await useApp.getState().applyConfig()).toBe(true);
  finish(); expect(await older).toBe(false);
  expect(committed).toEqual([7891]);
  expect(api.discardConfig).toHaveBeenCalledWith('/isolated/version-1.yaml');
});
