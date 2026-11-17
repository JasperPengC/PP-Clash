export interface LatencyBatchTarget {
  group: string;
  node: string;
  target: string;
}

export interface LatencyResult {
  node: string;
  target: string;
  delay: number | null;
}

export interface DelayTestOptions {
  publish?: boolean;
  isCurrent?: () => boolean;
}

export interface LatencyBatchProgress {
  completed: number;
  total: number;
  status: 'running' | 'completed' | 'cancelled';
}

export interface LatencyBatchUpdate {
  results: Array<LatencyBatchTarget & LatencyResult>;
  progress: LatencyBatchProgress;
}

interface BatchOptions {
  /** 不同运行配置或会话中的同名节点视为不同请求。 */
  requestScope?: string;
  measure: (item: LatencyBatchTarget) => Promise<number | null>;
  onUpdate: (update: LatencyBatchUpdate) => void;
  isCurrent?: () => boolean;
}

export interface LatencyBatchHandle {
  done: Promise<void>;
  cancel: (discardResults?: boolean) => void;
}

/** 调度器跨批次保留在途槽位；取消只丢弃后续工作，不增加请求或中断内核。 */
export function createLatencyBatchRunner() {
  let active = 0;
  let current: LatencyBatchHandle | undefined;
  const inFlight = new Set<string>();
  const queue: Array<{ key: string; run: () => void }> = [];
  const pump = () => {
    while (active < 3 && queue.length) {
      const index = queue.findIndex(item => !inFlight.has(item.key));
      if (index < 0) break;
      queue.splice(index, 1)[0].run();
    }
  };

  return {
    start(targets: LatencyBatchTarget[], options: BatchOptions): LatencyBatchHandle {
      current?.cancel(true);
      const unique = new Map<string, LatencyBatchTarget[]>();
      for (const item of targets) {
        const key = JSON.stringify([item.node, item.target]);
        const aliases = unique.get(key) ?? [];
        if (!aliases.some(alias => alias.group === item.group)) aliases.push(item);
        unique.set(key, aliases);
      }
      const progress: LatencyBatchProgress = { completed: 0, total: unique.size, status: 'running' };
      let results: LatencyBatchUpdate['results'] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      let resolveDone!: () => void;
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      const valid = () => progress.status === 'running' && (options.isCurrent?.() ?? true);
      const flush = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        const pending = results;
        results = [];
        options.onUpdate({ results: pending, progress: { ...progress } });
      };
      const cancel = (discardResults = false) => {
        if (progress.status !== 'running') return;
        if (discardResults || !(options.isCurrent?.() ?? true)) results = [];
        progress.status = 'cancelled';
        flush();
        resolveDone();
      };
      const handle = { done, cancel };
      current = handle;
      options.onUpdate({ results: [], progress: { ...progress } });

      for (const aliases of unique.values()) {
        const item = aliases[0];
        const key = JSON.stringify([options.requestScope ?? '', item.node, item.target]);
        queue.push({ key, run: () => {
          if (!valid()) { cancel(true); return; }
          active++;
          inFlight.add(key);
          let request: Promise<number | null>;
          try { request = Promise.resolve(options.measure(item)); }
          catch { request = Promise.resolve(null); }
          const finish = (delay: number | null) => {
            if (!valid()) { cancel(true); return; }
            results.push(...aliases.map(item => ({ ...item, delay })));
            progress.completed++;
            if (progress.completed === progress.total) {
              progress.status = 'completed';
              flush();
              resolveDone();
            } else if (timer === undefined) {
              timer = setTimeout(() => {
                if (!valid()) cancel(true);
                else flush();
              }, 200);
            }
          };
          void request.then(finish, () => finish(null)).finally(() => { inFlight.delete(key); active--; pump(); });
        } });
      }
      if (!unique.size) {
        progress.status = 'completed';
        flush();
        resolveDone();
      }
      pump();
      return handle;
    },
  };
}
