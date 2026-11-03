import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '../components/ui';
import { IconSearch, IconX } from '../components/icons';
import { IconLog } from '../components/icons';
import { useApp } from '../store/app';
import { api } from '../core/api';

function levelClass(line: string): string {
  if (/level=(fatal|error)/i.test(line)) return 'log-line err';
  if (/level=warn/i.test(line)) return 'log-line warn';
  if (/level=debug/i.test(line)) return 'log-line debug';
  return 'log-line';
}

export function LogsPage() {
  const kernelPhase = useApp((s) => s.kernelPhase);
  const connected = kernelPhase === 'running';

  const [text, setText] = useState('');
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [query, setQuery] = useState('');
  const viewRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    const load = async () => {
      try {
        const next = await api.readKernelLog(400);
        if (alive) setText(next);
      } catch {
        /* 忽略 */
      }
    };
    void load();
    const timer = window.setInterval(load, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [paused]);

  useEffect(() => {
    const el = viewRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const lines = text ? text.split('\n') : [];
  const shown = lines.filter((line) => {
    if (!line.trim()) return false;
    if (query && !line.toLowerCase().includes(query.toLowerCase())) return false;
    if (level === 'all') return true;
    if (level === 'error') return /level=(fatal|error)/i.test(line);
    if (level === 'warn') return /level=warn/i.test(line);
    return /level=info/i.test(line);
  });

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">日志</h1>
          <div className="page-sub">
            {connected ? '内核日志 · 最近 400 行' : '内核未运行'}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => setPaused((v) => !v)}>
            {paused ? '继续刷新' : '暂停'}
          </button>
        </div>
      </header>

      <div className="page-scroll page-fixed">
        <div className="page-inner">
          {lines.length > 0 && (
            <div className="row log-toolbar" style={{ gap: 10 }}>
              <div className="seg" role="group" aria-label="日志级别">
                {(
                  [
                    ['all', '全部'],
                    ['info', '信息'],
                    ['warn', '警告'],
                    ['error', '错误'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`seg-btn${level === value ? ' active' : ''}`}
                    onClick={() => setLevel(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="node-search">
                <IconSearch size={12} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索日志"
                  aria-label="搜索日志"
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
              <span className="card-hint">
                显示 {shown.length} / {lines.length}
              </span>
              <div className="spacer" />
            </div>
          )}

          {lines.length === 0 ? (
            <section className="card">
              <EmptyState
                icon={<IconLog size={19} />}
                title={connected ? '暂无日志' : '内核未运行'}
                desc={
                  connected
                    ? '暂无日志。'
                    : '未接管流量。'
                }
              />
            </section>
          ) : (
            <section className="card card-flush log-card">
              <div
                className="log-view"
                ref={viewRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                }}
              >
                {shown.map((line, i) => (
                  <div key={`${i}-${line.slice(0, 24)}`} className={levelClass(line)}>
                    {line}
                  </div>
                ))}
              </div>
            </section>
          )}
          {lines.length > 0 && shown.length === 0 && (
            <div className="card-hint" style={{ textAlign: 'center', padding: '8px 0' }}>
              没有匹配的日志
            </div>
          )}
        </div>
      </div>
    </>
  );
}
