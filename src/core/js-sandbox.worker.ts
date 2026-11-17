import { evaluateOverride, overrideErrorMessage } from './js-runtime';

self.onmessage = async (event: MessageEvent<{ config: Record<string, unknown>; script: string; timeoutMs: number }>) => {
  try {
    const { config, script, timeoutMs } = event.data;
    self.postMessage({ ok: true, config: await evaluateOverride(config, script, timeoutMs) });
  } catch (error) {
    self.postMessage({ ok: false, error: overrideErrorMessage(error) });
  }
};
