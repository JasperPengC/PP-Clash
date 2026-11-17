import { useEffect, useId, useRef, useState } from 'react';
import { api, type KernelReleaseInfo, type KernelVersionInfo } from '../core/api';
import { Dialog } from './Dialog';
import { EmptyState, ReadError, Spinner } from './ui';
import { IconCheck, IconDownload, IconRefresh, IconSearch, IconX } from './icons';

export function KernelVersionPicker({ open, installed, proxyUrl, disabled, onClose, onDownload }: {
  open: boolean;
  installed: KernelVersionInfo[];
  proxyUrl?: string;
  disabled: boolean;
  onClose: () => void;
  onDownload: (version: string) => void;
}) {
  const heading = useId();
  const [versions, setVersions] = useState<KernelReleaseInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(true);
  const pending = useRef(false);
  const retryPage = useRef(1);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async (nextPage = 1) => {
    if (pending.current) return;
    retryPage.current = nextPage;
    pending.current = true; setLoading(true);
    try {
      const result = await api.listKernelReleases(proxyUrl, nextPage);
      if (!Array.isArray(result)) throw new Error('版本列表响应格式异常');
      if (!alive.current) return;
      setVersions(previous => nextPage === 1 ? result : [...new Map([...previous, ...result].map(item => [item.version, item])).values()]);
      setPage(nextPage); setMore(result.length > 0 && nextPage < 100); setError('');
      if (nextPage === 1) setSelected(previous => result.some(item => item.version === previous) ? previous : '');
    } catch (error) { if (alive.current) setError(`版本读取失败：${String(error)}`); }
    finally { pending.current = false; if (alive.current) setLoading(false); }
  };
  useEffect(() => { if (open && page === 0) void load(); }, [open]);
  const filtered = versions.filter(item => item.version.toLowerCase().includes(query.trim().toLowerCase()));
  const isInstalled = (tag: string) => installed.some(item => item.version.replace(/^v/, '') === tag.replace(/^v/, ''));

  return <Dialog open={open} labelledBy={heading} busy={disabled} onDismiss={onClose}>
    <section className="kernel-version-picker">
      <div className="kernel-picker-head">
        <div><h2 id={heading} className="section-title">选择内核版本</h2><p className="field-hint">官方稳定版，下载后可在「使用版本」中切换。</p></div>
        <button type="button" className="icon-btn" aria-label="关闭版本选择" title="关闭" disabled={disabled} onClick={onClose}><IconX size={16} /></button>
      </div>
      <div className="kernel-picker-search">
        <label className="node-search"><IconSearch size={14} /><input className="input" aria-label="搜索内核版本" placeholder="搜索版本，如 1.19" value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} /></label>
        <button type="button" className="icon-btn" aria-label="刷新内核版本列表" title="刷新版本列表" disabled={loading} onClick={() => void load()}>{loading ? <Spinner small /> : <IconRefresh size={16} />}</button>
      </div>
      {error && <ReadError message={error} busy={loading} onRetry={() => void load(retryPage.current)} />}
      <div className="kernel-picker-scroll">
        {loading && !versions.length ? <EmptyState compact title="正在获取官方版本…" loading /> : !filtered.length && !error ? <EmptyState compact title={query ? '没有匹配的版本' : '暂无适用于本机的版本'} desc={more && page > 0 ? '可继续加载更早的版本。' : undefined} /> : null}
        <div className="kernel-picker-grid" role="group" aria-label="可下载的内核版本">
          {filtered.map(item => <button key={item.version} type="button" className="kernel-picker-option" aria-label={`选择 ${item.version}`} aria-pressed={selected === item.version} onClick={() => setSelected(item.version)}>
            <span>{item.version}</span><span className="kernel-picker-option-state">{isInstalled(item.version) && <span>已安装</span>}{selected === item.version && <IconCheck size={15} />}</span>
          </button>)}
        </div>
        {more && page > 0 && <button type="button" className="btn btn-ghost kernel-picker-more" disabled={loading} onClick={() => void load(page + 1)}>{loading ? <Spinner small /> : null}加载更多版本</button>}
      </div>
      <div className="kernel-picker-footer"><span className="field-hint">{selected || `已加载 ${versions.length} 个版本`}</span><div>
        <button type="button" className="btn btn-ghost" disabled={disabled} onClick={onClose}>取消</button>
        <button type="button" className="btn btn-primary" disabled={!selected || isInstalled(selected) || disabled || loading} onClick={() => onDownload(selected)}><IconDownload size={14} />{selected && isInstalled(selected) ? '已安装' : '下载版本'}</button>
      </div></div>
    </section>
  </Dialog>;
}
