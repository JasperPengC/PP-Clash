/**
 * JS 覆写沙箱。
 *
 * 生产环境放进 Blob Worker：
 * - 没有 DOM / window / Tauri IPC
 * - 禁用 fetch / XHR / WebSocket / importScripts
 * - 300ms 超时后 terminate，死循环不会卡住主界面
 *
 * Node 单测环境没有 Worker，回退为同步执行；浏览器/WKWebView 始终走 Worker。
 */

const TIMEOUT_MS = 300;

const WORKER_SOURCE = `
self.onmessage = function (event) {
  var script = event.data.script;
  var config = event.data.config;
  try {
    self.fetch = function () { throw new Error('sandbox: network disabled'); };
    self.XMLHttpRequest = function () { throw new Error('sandbox: network disabled'); };
    self.WebSocket = function () { throw new Error('sandbox: network disabled'); };
    self.EventSource = function () { throw new Error('sandbox: network disabled'); };
    self.importScripts = function () { throw new Error('sandbox: importScripts disabled'); };
    var fn = new Function('config', script + '\\n;return config;');
    var out = fn(config);
    self.postMessage({ ok: true, config: out });
  } catch (e) {
    self.postMessage({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};
`;

export interface SandboxRunOptions {
  timeoutMs?: number;
}

export async function runJsOverride(
  config: Record<string, unknown>,
  script: string,
  options: SandboxRunOptions = {}
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    // 单测 / Node 环境：Worker 不可用，退回同进程执行。生产构建不会走到这里。
    const fn = new Function('config', `${script}\n;return config;`);
    return fn(config) as Record<string, unknown>;
  }

  return new Promise((resolve, reject) => {
    const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`JS 覆写执行超时（${timeoutMs}ms）`));
    }, timeoutMs);

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.ok) {
        cleanup();
        const out = data.config;
        if (!out || typeof out !== 'object' || Array.isArray(out)) {
          reject(new Error('JS 覆写必须返回配置对象'));
        } else {
          resolve(out as Record<string, unknown>);
        }
      } else {
        cleanup();
        reject(new Error(String(data.error || 'JS 覆写执行失败')));
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || 'JS Worker 执行失败'));
    };

    worker.postMessage({ script, config });
  });
}
