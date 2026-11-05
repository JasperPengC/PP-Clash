import { useEffect, useState } from 'react';
import { EmptyState, Pill, Spinner } from '../components/ui';
import {
  IconFolder,
  IconGlobe,
  IconRefresh,
  IconSearch,
} from '../components/icons';
import { api } from '../core/api';
import { formatTime } from '../core/format';
import { useApp } from '../store/app';

interface ResourceFile {
  name: string;
  size: number;
  exists: boolean;
}

interface Provider {
  name: string;
  type?: string;
  vehicleType?: string;
  count?: number;
  ruleCount?: number;
  updatedAt?: string;
}

const FILE_INFO: Record<string, { label: string; note: string }> = {
  'geosite.dat': { label: 'GeoSite 域名库', note: '域名分类规则' },
  'geoip.metadb': { label: 'GeoIP 数据库', note: 'IP 归属地' },
  'geoip.dat': { label: 'GeoIP 旧格式', note: '兼容旧规则' },
  'country.mmdb': { label: 'Country 数据库', note: '国家 / 地区 IP' },
  'ASN.mmdb': { label: 'ASN 数据库', note: '运营商 / ASN' },
};

function fileLabel(name: string) {
  return FILE_INFO[name] ?? { label: name, note: '数据文件' };
}

function formatSize(bytes: number): string {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function providerTime(value?: string): string {
  if (!value) return '—';
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? '—' : formatTime(ms);
}

type Tab = 'geo' | 'rules' | 'proxies';

function ProviderList({
  emptyTitle,
  emptyDesc,
  providers,
  updating,
  onUpdate,
  query,
  busy,
}: {
  emptyTitle: string;
  emptyDesc: string;
  providers: Provider[];
  updating: string | null;
  onUpdate: (name: string) => Promise<void>;
  query: string;
  busy: boolean;
}) {
  const filtered = providers.filter((p) =>
    p.name.toLowerCase().includes(query.trim().toLowerCase())
  );

  if (providers.length === 0) {
    return <EmptyState icon={<IconFolder size={19} />} title={emptyTitle} desc={emptyDesc} />;
  }

  return (
    <>
      {filtered.length === 0 ? (
        <div className="resource-empty">没有匹配的提供者</div>
      ) : (
        <div className="resource-list">
          {filtered.map((p) => (
            <div key={p.name} className="resource-provider">
              <span className="resource-name" title={p.name}>{p.name}</span>
              <span className="tag">{p.vehicleType ?? p.type ?? 'provider'}</span>
              <span className="resource-meta">
                {p.ruleCount != null ? `${p.ruleCount} 条` : p.count != null ? `${p.count} 个` : '—'}
              </span>
              <span className="resource-meta resource-time">{providerTime(p.updatedAt)}</span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || updating !== null}
                onClick={() => void onUpdate(p.name)}
              >
                {updating === p.name ? <Spinner small /> : null}
                更新
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="btn resource-update-all"
        disabled={busy || updating !== null || filtered.length === 0}
        onClick={() => void (async () => {
          for (const p of filtered) {
            // 顺序更新，避免同时打满内核
            // eslint-disable-next-line no-await-in-loop
            await onUpdate(p.name);
          }
        })()}
      >
        更新当前列表
      </button>
    </>
  );
}

export function ResourcesPage() {
  const connected = useApp((s) => s.kernelPhase === 'running');
  const notify = useApp((s) => s.notify);

  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [rules, setRules] = useState<Provider[]>([]);
  const [proxies, setProxies] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const [reinstallConfirm, setReinstallConfirm] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('geo');
  const [query, setQuery] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const nextFiles = await api.listResourceFiles();
      setFiles(Array.isArray(nextFiles) ? nextFiles : []);
      if (connected) {
        const [ruleRaw, proxyRaw] = await Promise.all([
          api.mihomo('GET', '/providers/rules').catch(() => null),
          api.mihomo('GET', '/providers/proxies').catch(() => null),
        ]);
        const ruleMap = (ruleRaw as any)?.providers ?? {};
        const proxyMap = (proxyRaw as any)?.providers ?? {};
        setRules(
          Object.entries<any>(ruleMap).map(([name, p]) => ({
            name,
            type: p?.type,
            vehicleType: p?.vehicleType,
            ruleCount: p?.ruleCount,
            updatedAt: p?.updatedAt,
          }))
        );
        setProxies(
          Object.entries<any>(proxyMap)
            .filter(([, p]) => p?.vehicleType !== 'Compatible')
            .map(([name, p]) => ({
              name,
              type: p?.type,
              vehicleType: p?.vehicleType,
              count: Array.isArray(p?.proxies) ? p.proxies.length : undefined,
              updatedAt: p?.updatedAt,
            }))
            .sort((a, b) => {
              const order: Record<string, number> = { File: 1, Inline: 2, HTTP: 3 };
              return (order[a.vehicleType ?? ''] ?? 4) - (order[b.vehicleType ?? ''] ?? 4);
            })
        );
      } else {
        setRules([]);
        setProxies([]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [connected]);

  const reinstall = async () => {
    if (!reinstallConfirm) {
      setReinstallConfirm(true);
      window.setTimeout(() => setReinstallConfirm(false), 3000);
      return;
    }
    setReinstallConfirm(false);
    setReinstalling(true);
    try {
      await api.reinstallResources();
      await load();
      notify('success', '内置数据已重新解压');
    } catch (e) {
      notify('error', `解压失败：${String(e)}`);
    } finally {
      setReinstalling(false);
    }
  };

  const updateProvider = async (kind: 'rules' | 'proxies', name: string) => {
    setUpdating(name);
    try {
      await api.mihomo('PUT', `/providers/${kind}/${encodeURIComponent(name)}`);
      notify('success', `已更新 ${name}`);
      await load();
    } catch (e) {
      notify('error', `更新失败：${String(e)}`);
    } finally {
      setUpdating(null);
    }
  };

  const ready = files.filter((f) => f.exists).length;
  const tabs: Array<{ value: Tab; label: string; count?: number }> = [
    { value: 'geo', label: '内置数据' },
    { value: 'rules', label: '规则提供者', count: rules.length },
    { value: 'proxies', label: '代理提供者', count: proxies.length },
  ];

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">资源</h1>
          <div className="page-sub">
            {files.length > 0
              ? `${ready}/${files.length} 个数据文件 · ${rules.length} 个规则集 · ${proxies.length} 个代理集`
              : connected
                ? '读取内核资源'
                : '内核未运行'}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" disabled={loading} onClick={() => void load()}>
            {loading ? <Spinner small /> : <IconRefresh size={13} />}
            刷新
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void api.openDataDir('PPClash').catch(() => null)}
          >
            <IconFolder size={13} />
            打开目录
          </button>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner resources-page">
          <div className="resource-tabs" role="tablist" aria-label="资源类型">
            {tabs.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={tab === t.value}
                className={`resource-tab${tab === t.value ? ' active' : ''}`}
                onClick={() => {
                  setTab(t.value);
                  setQuery('');
                }}
              >
                {t.label}
                {t.count != null && <span className="resource-tab-count">{t.count}</span>}
              </button>
            ))}
          </div>

          {tab === 'geo' && (
            <section className="card">
              <div className="section-head">
                <span className="icon-tile"><IconGlobe size={15} /></span>
                <div className="section-head-text">
                  <div className="section-title">内置数据</div>
                  <div className="section-desc">GeoIP / GeoSite / ASN，随内核释放</div>
                </div>
                <div className="spacer" />
                <button
                  type="button"
                  className={`btn${reinstallConfirm ? ' danger' : ''}`}
                  disabled={reinstalling}
                  onClick={() => void reinstall()}
                >
                  {reinstalling ? <Spinner small /> : null}
                  {reinstallConfirm ? '确认重新解压' : '重新解压'}
                </button>
              </div>
              {files.length === 0 ? (
                <div className="resource-empty">{loading ? '读取中…' : '未找到数据文件'}</div>
              ) : (
                <div className="resource-list">
                  {files.map((f) => {
                    const info = fileLabel(f.name);
                    return (
                      <div key={f.name} className="resource-file">
                        <span className="resource-file-icon"><IconGlobe size={13} /></span>
                        <span className="resource-file-main">
                          <span className="resource-name">{info.label}</span>
                          <span className="resource-file-note">{f.name} · {info.note}</span>
                        </span>
                        <span className="resource-size">{formatSize(f.size)}</span>
                        <Pill tone={f.exists ? 'ok' : 'warn'}>{f.exists ? '就绪' : '缺失'}</Pill>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {tab !== 'geo' && (
            <section className="card">
              <div className="section-head">
                <span className="icon-tile"><IconFolder size={15} /></span>
                <div className="section-head-text">
                  <div className="section-title">
                    {tab === 'rules' ? '规则提供者' : '代理提供者'}
                  </div>
                  <div className="section-desc">
                    {tab === 'rules' ? '订阅里的 rule-providers' : '订阅里的 proxy-providers'}
                  </div>
                </div>
                <div className="spacer" />
                <label className="resource-search">
                  <IconSearch size={12} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="筛选"
                    aria-label="筛选提供者"
                    spellCheck={false}
                  />
                </label>
              </div>
              {!connected ? (
                <EmptyState
                  icon={<IconFolder size={19} />}
                  title="内核未运行"
                  desc="开启接管后显示规则与代理提供者。"
                />
              ) : (
                <ProviderList
                  emptyTitle={tab === 'rules' ? '没有规则提供者' : '没有代理提供者'}
                  emptyDesc={
                    tab === 'rules'
                      ? '当前订阅未声明 rule-providers。'
                      : '当前订阅未声明 proxy-providers。'
                  }
                  providers={tab === 'rules' ? rules : proxies}
                  updating={updating}
                  busy={loading}
                  query={query}
                  onUpdate={(name) => updateProvider(tab === 'rules' ? 'rules' : 'proxies', name)}
                />
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
