import { useEffect, useMemo, useState } from 'react';
import { EmptyState, navigate, Pill, Spinner } from '../components/ui';
import {
  IconActivity,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  IconSearch,
  IconX,
} from '../components/icons';
import { useApp } from '../store/app';
import { api } from '../core/api';
import { formatBytes } from '../core/format';

interface RawConn {
  id: string;
  upload: number;
  download: number;
  start: string;
  chains?: string[];
  rule?: string;
  rulePayload?: string;
  metadata?: {
    network?: string;
    host?: string;
    destinationIP?: string;
    destinationPort?: string | number;
    sourceIP?: string;
    process?: string;
  };
}

function hostOf(c: RawConn): string {
  const m = c.metadata ?? {};
  const host = m.host || m.destinationIP || m.sourceIP || '未知';
  const port = m.destinationPort ? `:${m.destinationPort}` : '';
  return `${host}${port}`;
}

export function ConnectionsPage() {
  const kernelPhase = useApp((s) => s.kernelPhase);
  const notify = useApp((s) => s.notify);
  const connected = kernelPhase === 'running';

  const [conns, setConns] = useState<RawConn[]>([]);
  const [totals, setTotals] = useState({ up: 0, down: 0 });
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'time' | 'down' | 'up'>('time');
  const [closingAll, setClosingAll] = useState(false);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const [view, setView] = useState<'conn' | 'process'>('conn');
  const [expandedProcess, setExpandedProcess] = useState<string | null>(null);
  const [closingProcess, setClosingProcess] = useState<string | null>(null);
  const [confirmProcess, setConfirmProcess] = useState<string | null>(null);

  const load = async () => {
    try {
      const data: any = await api.mihomo('GET', '/connections');
      setConns(data?.connections ?? []);
      setTotals({ up: data?.uploadTotal ?? 0, down: data?.downloadTotal ?? 0 });
    } catch {
      /* 内核没起来时保持空列表 */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const close = async (id: string) => {
    setClosing(id);
    try {
      await api.mihomo('DELETE', `/connections/${encodeURIComponent(id)}`);
      setConns((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      notify('error', `关闭连接失败：${String(e)}`);
    } finally {
      setClosing(null);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (q
      ? conns.filter((c) =>
          `${hostOf(c)} ${c.metadata?.process ?? ''} ${(c.chains ?? []).join(' ')} ${c.rule ?? ''} ${c.rulePayload ?? ''}`
            .toLowerCase()
            .includes(q)
        )
      : [...conns]
    ).sort((a, b) => {
      if (sortBy === 'down') return (b.download ?? 0) - (a.download ?? 0);
      if (sortBy === 'up') return (b.upload ?? 0) - (a.upload ?? 0);
      return Date.parse(b.start) - Date.parse(a.start);
    });
    return list;
  }, [conns, query, sortBy]);

  const processGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<
      string,
      { process: string; conns: RawConn[]; up: number; down: number; chains: Set<string> }
    >();
    for (const c of conns) {
      if (
        q &&
        !`${hostOf(c)} ${c.metadata?.process ?? ''} ${(c.chains ?? []).join(' ')} ${c.rule ?? ''}`
          .toLowerCase()
          .includes(q)
      ) {
        continue;
      }
      const name = c.metadata?.process || '未知进程';
      let g = map.get(name);
      if (!g) {
        g = { process: name, conns: [], up: 0, down: 0, chains: new Set() };
        map.set(name, g);
      }
      g.conns.push(c);
      g.up += c.upload ?? 0;
      g.down += c.download ?? 0;
      for (const ch of c.chains ?? []) g.chains.add(ch);
    }
    const list = [...map.values()];
    list.sort((a, b) =>
      sortBy === 'up' ? b.up - a.up : sortBy === 'down' ? b.down - a.down : a.process.localeCompare(b.process)
    );
    return list;
  }, [conns, query, sortBy]);

  const closeProcess = async (name: string, items: RawConn[]) => {
    if (confirmProcess !== name) {
      setConfirmProcess(name);
      window.setTimeout(() => setConfirmProcess((cur) => (cur === name ? null : cur)), 3000);
      return;
    }
    setConfirmProcess(null);
    setClosingProcess(name);
    try {
      await Promise.all(
        items.map((c) =>
          api.mihomo('DELETE', `/connections/${encodeURIComponent(c.id)}`).catch(() => null)
        )
      );
      const ids = new Set(items.map((c) => c.id));
      setConns((prev) => prev.filter((c) => !ids.has(c.id)));
      if (expandedProcess === name) setExpandedProcess(null);
      notify('success', `已关闭 ${name} 的 ${items.length} 条连接`);
    } catch (e) {
      notify('error', `关闭连接失败：${String(e)}`);
    } finally {
      setClosingProcess(null);
    }
  };

  const closeAll = async () => {
    if (!confirmCloseAll) {
      setConfirmCloseAll(true);
      window.setTimeout(() => setConfirmCloseAll(false), 3000);
      return;
    }
    setConfirmCloseAll(false);
    setClosingAll(true);
    try {
      await api.mihomo('DELETE', '/connections');
      setConns([]);
      notify('success', '已关闭所有连接');
    } catch (e) {
      notify('error', `操作失败：${String(e)}`);
    } finally {
      setClosingAll(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">连接</h1>
          <div className="page-sub">
            {connected ? `${conns.length} 个活动连接` : '内核未运行'}
          </div>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            disabled={!connected || conns.length === 0 || closingAll}
            onClick={() => void closeAll()}
          >
            {closingAll ? <Spinner small /> : null}
            {confirmCloseAll ? '确认关闭' : '关闭所有连接'}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="刷新"
            aria-label="刷新"
            onClick={() => void load()}
          >
            <IconRefresh size={15} />
          </button>
        </div>
      </header>

      <div className="page-scroll page-fixed">
        <div className="page-inner">
          {!connected ? (
            <section className="card">
              <EmptyState
                icon={<IconActivity size={19} />}
                title="内核未运行"
                desc="开启接管后显示连接。"
                action={
                  <button type="button" className="btn btn-primary" onClick={() => navigate('overview')}>
                    去概览
                  </button>
                }
              />
            </section>
          ) : conns.length === 0 ? (
            <section className="card">
              <EmptyState
                icon={<IconActivity size={19} />}
                title={loading ? '读取中…' : '暂无活动连接'}
                desc={loading ? '' : ''}
              />
            </section>
          ) : (
            <>
              <div className="row conn-toolbar" style={{ gap: 8 }}>
                <Pill tone="accent">
                  <IconActivity size={11} />
                  {conns.length} 条
                </Pill>
                <span className="card-hint">本会话 {formatBytes(totals.up + totals.down)}</span>
                <div className="seg" role="group" aria-label="连接视图">
                  {(
                    [
                      ['conn', '连接'],
                      ['process', '按进程'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`seg-btn${view === value ? ' active' : ''}`}
                      onClick={() => setView(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="seg" role="group" aria-label="连接排序">
                  {(
                    [
                      ['time', '时间'],
                      ['down', '下载'],
                      ['up', '上传'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`seg-btn${sortBy === value ? ' active' : ''}`}
                      onClick={() => setSortBy(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="spacer" />
                <div className="node-search">
                  <IconSearch size={12} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索主机 / 进程 / 规则"
                    aria-label="搜索连接"
                    spellCheck={false}
                  />
                  {query && (
                    <button
                      type="button"
                      className="node-search-clear"
                      aria-label="清空搜索"
                      onClick={() => setQuery('')}
                    >
                      <IconX size={11} />
                    </button>
                  )}
                </div>
              </div>

              <section className="card card-flush connections-card">
                {view === 'conn' ? (
                  <div className="list conn-list">
                    {visible.length === 0 && (
                      <div className="node-empty">没有匹配的连接</div>
                    )}
                    {visible.map((c) => (
                      <div key={c.id} className="conn-row">
                        <span className="conn-main">
                          <span className="conn-host">{hostOf(c)}</span>
                          <span className="conn-sub">
                            {c.metadata?.network ?? 'tcp'}
                            {c.chains && c.chains.length > 0
                              ? ` · ${c.chains.join(' → ')}`
                              : ''}
                            {c.rule ? ` · ${c.rule}${c.rulePayload ? ` ${c.rulePayload}` : ''}` : ''}
                          </span>
                        </span>
                        <span className="conn-traffic">
                          ↑ {formatBytes(c.upload)} ↓ {formatBytes(c.download)}
                        </span>
                        <button
                          type="button"
                          className="icon-btn danger"
                          title="断开此连接"
                          aria-label="断开此连接"
                          disabled={closing === c.id}
                          onClick={() => void close(c.id)}
                        >
                          {closing === c.id ? <Spinner small /> : <IconX size={12} />}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="list conn-list">
                    {processGroups.length === 0 && (
                      <div className="node-empty">没有匹配的连接</div>
                    )}
                    {processGroups.map((g) => {
                      const open = expandedProcess === g.process;
                      return (
                        <div key={g.process} className="proc-group">
                          <div className="conn-row proc-row">
                            <button
                              type="button"
                              className="proc-expand"
                              aria-label={open ? '收起进程连接' : '展开进程连接'}
                              onClick={() => setExpandedProcess(open ? null : g.process)}
                            >
                              {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                            </button>
                            <span className="conn-main">
                              <span className="conn-host">{g.process}</span>
                              <span className="conn-sub">
                                {g.conns.length} 条连接
                                {g.chains.size ? ` · ${[...g.chains].slice(0, 4).join(' → ')}` : ''}
                              </span>
                            </span>
                            <span className="conn-traffic">
                              ↑ {formatBytes(g.up)} ↓ {formatBytes(g.down)}
                            </span>
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={closingProcess === g.process}
                              onClick={() => void closeProcess(g.process, g.conns)}
                            >
                              {confirmProcess === g.process ? '确认关闭' : '关闭进程连接'}
                            </button>
                          </div>
                          {open && (
                            <div className="proc-children">
                              {g.conns.map((c) => (
                                <div key={c.id} className="conn-row proc-child">
                                  <span className="conn-main">
                                    <span className="conn-host">{hostOf(c)}</span>
                                    <span className="conn-sub">
                                      {c.metadata?.network ?? 'tcp'}
                                      {c.rule ? ` · ${c.rule}${c.rulePayload ? ` ${c.rulePayload}` : ''}` : ''}
                                    </span>
                                  </span>
                                  <span className="conn-traffic">
                                    ↑ {formatBytes(c.upload)} ↓ {formatBytes(c.download)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
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
