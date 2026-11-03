import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../components/ui';
import { IconActivity, IconDownload, IconUpload } from '../components/icons';
import { api } from '../core/api';
import { formatBytes } from '../core/format';
import { useApp } from '../store/app';

interface RawConn {
  id: string;
  upload: number;
  download: number;
  chains?: string[];
  metadata?: { process?: string; processPath?: string };
}

interface Row {
  name: string;
  count: number;
  upload: number;
  download: number;
}

function aggregate(conns: RawConn[], pick: (c: RawConn) => string): Row[] {
  const map = new Map<string, Row>();
  for (const c of conns) {
    const name = pick(c) || '未知';
    const row = map.get(name) ?? { name, count: 0, upload: 0, download: 0 };
    row.count += 1;
    row.upload += c.upload ?? 0;
    row.download += c.download ?? 0;
    map.set(name, row);
  }
  return [...map.values()].sort(
    (a, b) => b.upload + b.download - (a.upload + a.download)
  );
}

export function TrafficPage() {
  const connected = useApp((s) => s.kernelPhase === 'running');
  const [conns, setConns] = useState<RawConn[]>([]);
  const [totals, setTotals] = useState({ up: 0, down: 0 });
  const [icons, setIcons] = useState<Record<string, string>>({});
  const requestedIcons = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!connected) {
      setConns([]);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const data: any = await api.mihomo('GET', '/connections');
        if (!alive) return;
        setConns(data?.connections ?? []);
        setTotals({ up: data?.uploadTotal ?? 0, down: data?.downloadTotal ?? 0 });
      } catch {
        /* ignore */
      }
    };
    void load();
    const timer = window.setInterval(load, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [connected]);

  const byNode = useMemo(
    () => aggregate(conns, (c) => c.chains?.[0] || 'DIRECT'),
    [conns]
  );
  const processPaths = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of conns) {
      const path = c.metadata?.processPath;
      if (!path) continue;
      const name =
        c.metadata?.process || path.split('/').filter(Boolean).pop() || path;
      if (!map[name]) map[name] = path;
    }
    return map;
  }, [conns]);

  const byProcess = useMemo(
    () =>
      aggregate(conns, (c) => {
        if (c.metadata?.process) return c.metadata.process;
        const path = c.metadata?.processPath;
        if (path) return path.split('/').filter(Boolean).pop() || path;
        return '未知';
      }),
    [conns]
  );

  useEffect(() => {
    for (const [name, path] of Object.entries(processPaths)) {
      if (requestedIcons.current.has(name)) continue;
      requestedIcons.current.add(name);
      void api
        .resolveProcessIcon(path)
        .then((icon) => {
          if (icon) setIcons((prev) => ({ ...prev, [name]: icon }));
        })
        .catch(() => {
          /* 拿不到图标就保持文字 */
        });
    }
  }, [processPaths]);

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">流量</h1>
          <div className="page-sub">
            {connected ? `本会话 ${formatBytes(totals.up + totals.down)}` : '内核未运行'}
          </div>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner">
          {!connected ? (
            <section className="card">
              <EmptyState
                icon={<IconActivity size={19} />}
                title="内核未运行"
                desc="未接管流量。"
              />
            </section>
          ) : (
            <>
              <div className="traffic-stats">
                <div className="card traffic-stat">
                  <span className="icon-tile up">
                    <IconUpload size={15} />
                  </span>
                  <div>
                    <div className="traffic-stat-label">上传</div>
                    <div className="traffic-stat-value">{formatBytes(totals.up)}</div>
                  </div>
                </div>
                <div className="card traffic-stat">
                  <span className="icon-tile down">
                    <IconDownload size={15} />
                  </span>
                  <div>
                    <div className="traffic-stat-label">下载</div>
                    <div className="traffic-stat-value">{formatBytes(totals.down)}</div>
                  </div>
                </div>
                <div className="card traffic-stat">
                  <span className="icon-tile">
                    <IconActivity size={15} />
                  </span>
                  <div>
                    <div className="traffic-stat-label">活动连接</div>
                    <div className="traffic-stat-value">{conns.length}</div>
                  </div>
                </div>
              </div>

              <section className="card">
                <div className="section-title">按节点</div>
                {byNode.length === 0 ? (
                  <div className="rule-empty">暂无流量</div>
                ) : (
                  <div className="traffic-list">
                    <div className="traffic-row traffic-head">
                      <span>节点</span>
                      <span>连接</span>
                      <span>上传</span>
                      <span>下载</span>
                    </div>
                    {byNode.map((r) => (
                      <div key={r.name} className="traffic-row">
                        <span className="traffic-name" title={r.name}>
                          {r.name}
                        </span>
                        <span>{r.count}</span>
                        <span>{formatBytes(r.upload)}</span>
                        <span>{formatBytes(r.download)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="card">
                <div className="section-title">按进程</div>
                {byProcess.length === 0 ? (
                  <div className="rule-empty">暂无流量</div>
                ) : (
                  <div className="traffic-list">
                    <div className="traffic-row traffic-head">
                      <span>进程</span>
                      <span>连接</span>
                      <span>上传</span>
                      <span>下载</span>
                    </div>
                    {byProcess.map((r) => (
                      <div key={r.name} className="traffic-row">
                        <span className="traffic-name traffic-name-cell" title={r.name}>
                          {icons[r.name] ? (
                            <img className="traffic-icon" src={icons[r.name]} alt="" />
                          ) : (
                            <span className="traffic-icon-placeholder" />
                          )}
                          <span className="traffic-name-text">{r.name}</span>
                        </span>
                        <span>{r.count}</span>
                        <span>{formatBytes(r.upload)}</span>
                        <span>{formatBytes(r.download)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
