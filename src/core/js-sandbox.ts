/** JS 覆写在独立解释器中执行，浏览器再用 Worker 隔离 CPU 工作。 */
const TIMEOUT_MS = 300;
const INITIALIZE_TIMEOUT_MS = 10_000;
export interface SandboxRunOptions { timeoutMs?: number }
export async function runJsOverride(
  config: Record<string, unknown>, script: string, options: SandboxRunOptions = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS));
  if (typeof Worker === 'undefined') {
    if (typeof window !== 'undefined') throw new Error('当前环境不支持隔离脚本，请使用 YAML 覆写');
    // Node 验证也执行同一隔离解释器，绝不回退到宿主 new Function。
    const { evaluateOverride } = await import('./js-runtime');
    return evaluateOverride(config, script, timeoutMs);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./js-sandbox.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      action();
    };
    // 初始化不占用脚本300ms执行预算；解释器内还有时间/内存上限。
    const timer = setTimeout(() => finish(() => reject(new Error('JS 覆写初始化或执行超时'))), INITIALIZE_TIMEOUT_MS + timeoutMs);
    worker.onmessage = (event: MessageEvent) => finish(() => {
      const data = event.data;
      if (!data?.ok) reject(new Error(typeof data?.error === 'string' ? data.error : 'JS 覆写执行失败'));
      else if (!data.config || typeof data.config !== 'object' || Array.isArray(data.config)) reject(new Error('JS 覆写必须返回配置对象'));
      else resolve(data.config);
    });
    worker.onerror = () => finish(() => reject(new Error('JS 覆写运行环境加载失败')));
    try { worker.postMessage({ config, script, timeoutMs }); }
    catch { finish(() => reject(new Error('JS 覆写输入无法序列化'))); }
  });
}
