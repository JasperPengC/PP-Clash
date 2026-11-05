import { afterEach, describe, expect, it, vi } from 'vitest';
import { runJsOverride } from '../src/core/js-sandbox';

class FakeWorker {
  static mode: 'ok' | 'error' | 'hang' = 'ok';
  static lastConfig: unknown;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  constructor(_url: string) {}
  postMessage(data: { config: unknown }) {
    FakeWorker.lastConfig = data.config;
    if (FakeWorker.mode === 'ok') {
      setTimeout(
        () => this.onmessage?.({ data: { ok: true, config: { sandboxed: true } } } as MessageEvent),
        0
      );
    } else if (FakeWorker.mode === 'error') {
      setTimeout(
        () => this.onmessage?.({ data: { ok: false, error: 'boom' } } as MessageEvent),
        0
      );
    }
  }
  terminate() {}
}

const originalWorker = globalThis.Worker;

function installWorker(mode: 'ok' | 'error' | 'hang') {
  FakeWorker.mode = mode;
  (globalThis as any).Worker = FakeWorker;
}

afterEach(() => {
  (globalThis as any).Worker = originalWorker;
  vi.restoreAllMocks();
});

describe('JS 覆写沙箱', () => {
  it('worker 成功返回配置', async () => {
    installWorker('ok');
    const out = await runJsOverride({ a: 1 }, 'config.b = 2');
    expect(out).toEqual({ sandboxed: true });
    expect(FakeWorker.lastConfig).toEqual({ a: 1 });
  });

  it('worker 抛错时返回明确错误', async () => {
    installWorker('error');
    await expect(runJsOverride({}, 'throw new Error("x")')).rejects.toThrow('boom');
  });

  it('超时会 reject 并结束 worker', async () => {
    installWorker('hang');
    await expect(runJsOverride({}, 'while(true){}', { timeoutMs: 20 })).rejects.toThrow(
      '超时'
    );
  });

  it('返回非对象时报错', async () => {
    installWorker('ok');
    // 覆盖 FakeWorker 的返回内容
    FakeWorker.prototype.postMessage = function (_data: unknown) {
      setTimeout(
        () => this.onmessage?.({ data: { ok: true, config: 42 } } as MessageEvent),
        0
      );
    } as any;
    await expect(runJsOverride({}, 'return 42')).rejects.toThrow('配置对象');
  });
});
