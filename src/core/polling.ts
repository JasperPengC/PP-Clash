/** 展示用轮询：请求串行；停止后不再调度，恢复由调用方重新启动。 */
export function startPolling(task: () => void | Promise<void>, interval: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try { await task(); } catch { /* 下一轮恢复 */ }
    if (!stopped) timer = setTimeout(() => void tick(), interval);
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
/** 可暂停的串行轮询：隐藏时无定时器，恢复时等待旧回包后立即刷新。 */
export function createActivityPolling(task: () => Promise<unknown>, interval: number) {
  let active = false;
  let disposed = false;
  let inFlight = false;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const tick = async () => {
    if (!active || disposed) return;
    if (inFlight) { queued = true; return; }
    inFlight = true;
    queued = false;
    try { await task(); } catch { /* 下一轮允许重试。 */ }
    finally {
      inFlight = false;
      if (active && !disposed) {
        if (queued) void tick();
        else timer = setTimeout(() => { timer = undefined; void tick(); }, interval);
      }
    }
  };
  return {
    resume() {
      if (active || disposed) return;
      active = true;
      void tick();
    },
    pause() { active = false; queued = false; clear(); },
    refresh() { if (active && !disposed) { clear(); void tick(); } },
    dispose() { disposed = true; active = false; queued = false; clear(); },
  };
}
