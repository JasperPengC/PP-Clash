import { describe, expect, it, vi } from 'vitest';
import { runJsOverride } from '../src/core/js-sandbox';
describe('JS 覆写隔离运行时', () => {
  it('执行真实脚本并隔离每次运行及输入对象', async () => {
    const input = { nested: { value: 1 } };
    expect(await runJsOverride(input, 'config.nested.value = 2; globalThis.marker = 3;')).toEqual({ nested: { value: 2 } });
    expect(input.nested.value).toBe(1);
    expect(await runJsOverride({}, 'config.marker = typeof marker;')).toEqual({ marker: 'undefined' });
  });
  it('构造器链只能取得解释器全局，无法访问网络、子Worker或宿主', async () => {
    const out = await runJsOverride({}, `const g = ({}).constructor.constructor('return globalThis')();
      config.types = ['fetch','Worker','SharedWorker','XMLHttpRequest','WebSocket','importScripts','process','require','window','document','__TAURI_INTERNALS__'].map(k => typeof g[k]);`);
    expect(out.types).toEqual(Array(11).fill('undefined'));
  });
  it('错误不回显脚本中的凭据', async () => {
    await expect(runJsOverride({ password: 'synthetic-private' }, 'throw new Error(config.password);')).rejects.toThrow('JS 覆写执行失败');
    try { await runJsOverride({ password: 'synthetic-private' }, 'throw new Error(config.password);'); }
    catch (error) { expect(String(error)).not.toContain('synthetic-private'); }
  });
  it('脚本的对象序列化钩子不能改写宿主返回协议或泄漏解析错误', async () => {
    const marker = 'synthetic-bridge-fixture';
    const script = `Object.prototype.toJSON = function () {
      return { kind: 'ok', json: config.marker };
    };`;
    await expect(runJsOverride({ marker }, script)).resolves.toEqual({ kind: 'ok', json: marker });
    expect(await runJsOverride({}, 'config.ok = true;')).toEqual({ ok: true });
  });
  it('宿主 JSON 解析异常只返回固定错误，释放解释器后仍能继续运行', async () => {
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (text === '{"hostParseFixture":true}') throw new SyntaxError('synthetic-parse-fixture');
      return parse(text, reviver);
    });
    try {
      await expect(runJsOverride({}, 'config.hostParseFixture = true;')).rejects.toThrow(/^JS 覆写结果无法解析$/);
    } finally {
      spy.mockRestore();
    }
    expect(await runJsOverride({}, 'config.ok = true;')).toEqual({ ok: true });
  });
  it('Worker 不向调用者回传未知宿主异常正文', async () => {
    const endpoint = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => Promise<void>) | null };
    vi.stubGlobal('self', endpoint);
    try {
      await import('../src/core/js-sandbox.worker');
      const event = Object.defineProperty({}, 'data', { get() { throw new Error('synthetic-worker-fixture'); } });
      await endpoint.onmessage!(event as MessageEvent);
      expect(endpoint.postMessage).toHaveBeenLastCalledWith({ ok: false, error: 'JS 覆写执行失败' });
      await endpoint.onmessage!({ data: { config: {}, script: 'config.ok = true;', timeoutMs: 300 } } as MessageEvent);
      expect(endpoint.postMessage).toHaveBeenLastCalledWith({ ok: true, config: { ok: true } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('只接受可序列化的配置对象', async () => {
    await expect(runJsOverride({}, 'return 42;')).rejects.toThrow('配置对象');
    await expect(runJsOverride({}, 'return Promise.resolve(config);')).rejects.toThrow('异步');
    await expect(runJsOverride({}, 'config.self = config;')).rejects.toThrow('序列化');
    await expect(runJsOverride({}, 'config.toJSON = () => undefined;')).rejects.toThrow('序列化');
    await expect(runJsOverride({}, 'config.toJSON = () => "synthetic-json-scalar";')).rejects.toThrow(/^JS 覆写必须返回配置对象$/);
  });
  it('死循环和过量分配可中断，随后仍能运行正常脚本', async () => {
    await expect(runJsOverride({}, 'while (true) {}', { timeoutMs: 20 })).rejects.toThrow('超时');
    await expect(runJsOverride({}, 'config.big = "x".repeat(128 * 1024 * 1024);')).rejects.toThrow();
    expect(await runJsOverride({}, 'config.ok = true;')).toEqual({ ok: true });
  });
});
