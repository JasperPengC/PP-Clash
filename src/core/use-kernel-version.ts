import { useEffect, useState } from 'react';
import { api } from './api';
import type { KernelPhase } from '../domain/app';

/** 只在内核阶段、路径或运行代次变化时读取，迟到结果不能覆盖新内核。 */
export function useKernelVersion(phase: KernelPhase, path: string, connectedAt: number | null) {
  const scope = JSON.stringify([phase, path, connectedAt]);
  const [read, setRead] = useState<{ scope: string; version: string | null } | null>(null);
  const transitioning = phase === 'starting' || phase === 'stopping';
  useEffect(() => {
    let current = true;
    if (transitioning) return;
    const load = async () => {
      let version: string | null = null;
      try {
        if (phase === 'running') {
          const info = await api.kernelInfo();
          if (info?.running) version = info.version?.trim() || null;
        } else {
          const versions = await api.listKernelVersions();
          const selected = versions.find(item => path ? item.path === path : item.builtin);
          version = selected?.version.trim() || null;
        }
      } catch { /* 未确认的版本保持未知，不用应用或内置版本代替。 */ }
      if (current) setRead({ scope, version });
    };
    void load();
    return () => { current = false; };
  }, [phase, path, connectedAt, scope, transitioning]);

  const confirmed = read?.scope === scope ? read : null;
  const full = confirmed?.version ?? null;
  const numeric = full?.match(/v?\d+\.\d+\.\d+/)?.[0];
  return {
    full,
    label: full ? numeric ? numeric.startsWith('v') ? numeric : `v${numeric}` : full
      : transitioning ? '待确认' : confirmed ? '版本未知' : '读取中…',
  };
}
