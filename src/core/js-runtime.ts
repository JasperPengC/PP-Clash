import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-sync';

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MEMORY_BYTES = 64 * 1024 * 1024;
let modulePromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;

// 只允许宿主主动构造的固定错误穿过 Worker 边界。
class OverrideError extends Error {}
export function overrideErrorMessage(error: unknown): string {
  return error instanceof OverrideError ? error.message : 'JS 覆写执行失败';
}

/** 独立解释器只接收 JSON，不注入任何宿主函数、模块加载器、网络或 IPC。 */
export async function evaluateOverride(
  config: Record<string, unknown>, script: string, timeoutMs: number,
): Promise<Record<string, unknown>> {
  try {
    return await evaluateInRuntime(config, script, timeoutMs);
  } catch (error) {
    throw new OverrideError(overrideErrorMessage(error));
  }
}

async function evaluateInRuntime(
  config: Record<string, unknown>, script: string, timeoutMs: number,
): Promise<Record<string, unknown>> {
  const input = JSON.stringify(config);
  if (!input || input.length > MAX_JSON_BYTES || script.length > MAX_JSON_BYTES)
    throw new OverrideError('JS 覆写输入过大');
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant).catch(error => {
    modulePromise = undefined;
    throw error;
  });
  const module = await modulePromise;
  const runtime = module.newRuntime();
  try {
    runtime.setMemoryLimit(MEMORY_BYTES);
    runtime.setMaxStackSize(512 * 1024);
    let interrupted = false;
    const deadline = performance.now() + timeoutMs;
    runtime.setInterruptHandler(() => (interrupted ||= performance.now() >= deadline));
    const context = runtime.newContext();
    try {
      // 协议只能是原始字符串，禁止 dump 对象触发脚本改写的 toJSON/序列化钩子。
      const source = `(function () {
        const encode = JSON.stringify;
        const isArray = Array.isArray;
        const config = JSON.parse(${JSON.stringify(input)});
        const out = (function (config) { ${script}\n;return config; })(config);
        if (!out || typeof out !== 'object' || isArray(out)) return 'OBJECT';
        if (typeof out.then === 'function') return 'ASYNC';
        try {
          const json = encode(out);
          return typeof json === 'string' ? 'OK:' + json : 'JSON';
        } catch (_) { return 'JSON'; }
      })()`;
      const result = context.evalCode(source, 'override.js');
      try {
        if (result.error) {
          throw new OverrideError(interrupted ? `JS 覆写执行超时（${timeoutMs}ms）` : 'JS 覆写执行失败，请检查语法和内存用量');
        }
        if (context.typeof(result.value) !== 'string') throw new OverrideError('JS 覆写返回协议无效');
        const output = context.getString(result.value);
        if (interrupted) throw new OverrideError(`JS 覆写执行超时（${timeoutMs}ms）`);
        if (output === 'ASYNC') throw new OverrideError('JS 覆写不支持异步返回');
        if (output === 'OBJECT') throw new OverrideError('JS 覆写必须返回配置对象');
        if (!output.startsWith('OK:')) throw new OverrideError('JS 覆写结果无法序列化');
        const json = output.slice(3);
        if (json.length > MAX_JSON_BYTES) throw new OverrideError('JS 覆写结果过大');
        let parsed: unknown;
        try { parsed = JSON.parse(json); }
        catch { throw new OverrideError('JS 覆写结果无法解析'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new OverrideError('JS 覆写必须返回配置对象');
        return parsed as Record<string, unknown>;
      } finally {
        if (result.error) result.error.dispose();
        else result.value.dispose();
      }
    } finally {
      context.dispose();
    }
  } finally {
    runtime.dispose();
  }
}
