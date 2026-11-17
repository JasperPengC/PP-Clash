import { useEffect, useState } from 'react';
import { api } from './api';

export interface TakeoverStatusInput {
  active: boolean;
  running: boolean;
  sysProxy: boolean;
  tun: boolean;
  revision: string | number;
  transitioning?: boolean;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

function systemProxySubtitle(value: unknown): string | null {
  const proxy = record(value);
  const port = proxy?.port;
  return proxy?.enabled === true && typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
    ? `端口 ${port}` : null;
}

function tunSubtitle(value: unknown): string | null {
  const tun = record(record(value)?.tun);
  if (tun?.enable !== true || typeof tun.device !== 'string' || !tun.device.trim()
    || typeof tun.stack !== 'string' || !tun.stack.trim()) return null;
  return `${tun.device.trim()} · ${tun.stack.trim()}`;
}

/** revision 只包含已应用配置与内核运行代次；不接收尚未应用的设置作为生效参数。 */
export function useTakeoverStatus({ active, running, sysProxy, tun, revision, transitioning = false }: TakeoverStatusInput) {
  const scope = JSON.stringify([active, running, sysProxy, tun, revision, transitioning]);
  const [observed, setObserved] = useState<{ scope: string; proxy: string | null; tun: string | null } | null>(null);

  useEffect(() => {
    let current = true;
    setObserved(null);
    if (!active || !running || transitioning) return;

    const read = async (kind: 'proxy' | 'tun') => {
      let subtitle: string | null = null;
      try {
        subtitle = kind === 'proxy'
          ? systemProxySubtitle(await api.getSystemProxy())
          : tunSubtitle(await api.mihomo('GET', '/configs'));
      } catch { /* 读取失败保持待确认，不沿用上一代结果。 */ }
      if (current) setObserved(previous => ({
        scope,
        proxy: previous?.scope === scope ? previous.proxy : null,
        tun: previous?.scope === scope ? previous.tun : null,
        [kind]: subtitle,
      }));
    };
    if (sysProxy) void read('proxy');
    if (tun) void read('tun');
    return () => { current = false; };
  }, [active, running, sysProxy, tun, revision, transitioning, scope]);

  const subtitle = (enabled: boolean, value: string | null | undefined) => {
    if (transitioning) return '待确认';
    if (!running) return '内核未运行';
    if (!enabled) return '未开启';
    return active && observed?.scope === scope && value ? value : '待确认';
  };
  return {
    systemProxySubtitle: subtitle(sysProxy, observed?.proxy),
    tunSubtitle: subtitle(tun, observed?.tun),
  };
}
