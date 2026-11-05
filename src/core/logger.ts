import { api, isTauri } from './api';

export function logEvent(level: 'info' | 'warn' | 'error', message: string) {
  if (!isTauri) return;
  void api.appendDiagnosticLog(level, message).catch(() => undefined);
}

/** 全局异常也写进 app.log，诊断包才能看到前端崩溃。 */
export function installLogger() {
  if (!isTauri) return;
  logEvent('info', `app started version=${__BUILD_TIME__}`);
  window.addEventListener('error', (event) => {
    logEvent('error', `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    logEvent('error', `unhandled rejection: ${String(event.reason)}`);
  });
}
