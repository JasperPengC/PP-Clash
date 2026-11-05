import { useEffect, useState } from 'react';
import { EmptyState, Pill, Segmented, Spinner, Toggle } from '../components/ui';
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

const GEO_FILE_KEY: Record<string, keyof typeof DEFAULT_GEO_URLS> = {
  'geoip.dat': 'geoip',
  'geosite.dat': 'geosite',
  'geoip.metadb': 'mmdb',
  'ASN.mmdb': 'asn',
  'country.mmdb': 'country',
};

const DEFAULT_GEO_URLS = {
  geoip: '',
  geosite: '',
  mmdb: '',
  asn: '',
  country: '',
};

const GEO_SOURCE_INFO: Array<{ key: keyof typeof DEFAULT_GEO_URLS; label: string; file: string }> = [
  { key: 'geoip', label: 'GeoIP 数据库', file: 'geoip.dat' },
  { key: 'geosite', label: 'GeoSite 数据库', file: 'geosite.dat' },
  { key: 'mmdb', label: 'MMDB 数据库', file: 'geoip.metadb' },
  { key: 'asn', label: 'ASN 数据库', file: 'ASN.mmdb' },
  { key: 'country', label: 'Country 数据库', file: 'country.mmdb' },
];

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
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);

  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [rules, setRules] = useState<Provider[]>([]);
  const [proxies, setProxies] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const [reinstallConfirm, setReinstallConfirm] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [geoUpdating, setGeoUpdating] = useState<string | null>(null);
  const [urlDrafts, setUrlDrafts] = useState(settings.geoUrls);
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

  const updateGeo = async (name: string) => {
    setGeoUpdating(name);
    try {
      const proxyUrl =
        settings.githubProxy === 'auto' && connected
          ? `http://127.0.0.1:${settings.mixedPort}`
          : undefined;
      const mirrorPrefix =
        settings.githubProxy && settings.githubProxy !== 'auto'
          ? settings.githubProxy
          : undefined;
      const key = GEO_FILE_KEY[name];
      const sourceUrl = key ? settings.geoUrls[key] : '';
      if (!sourceUrl) {
        notify('error', `${name} 没有配置在线源`);
        return;
      }
      await api.downloadGeoResource(name, sourceUrl, proxyUrl, mirrorPrefix);
      await load();
      notify('success', `${name} 已更新，重启内核后生效`);
    } catch (e) {
      notify('error', `更新 ${name} 失败：${String(e)}`);
    } finally {
      setGeoUpdating(null);
    }
  };

  const updateAllGeo = async () => {
    for (const item of GEO_SOURCE_INFO) {
      // 顺序更新，避免并发下载占满带宽
      // eslint-disable-next-line no-await-in-loop
      await updateGeo(item.file);
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
                  <div className="section-desc">内置源来自 MetaCubeX；在线更新会覆盖内置文件</div>
                </div>
                <div className="spacer" />
                <button
                  type="button"
                  className="btn"
                  disabled={geoUpdating !== null || files.length === 0}
                  onClick={() => void updateAllGeo()}
                >
                  {geoUpdating ? <Spinner small /> : <IconRefresh size={13} />}
                  在线更新
                </button>
                <button
                  type="button"
                  className={`btn${reinstallConfirm ? ' danger' : ''}`}
                  disabled={reinstalling}
                  onClick={() => void reinstall()}
                >
                  {reinstalling ? <Spinner small /> : null}
                  {reinstallConfirm ? '确认恢复内置' : '恢复内置 Geo'}
                </button>
              </div>
              <div className="geo-source-list">
                {GEO_SOURCE_INFO.map((item) => {
                  const file = files.find((f) => f.name === item.file);
                  return (
                    <div className="geo-source-row" key={item.key}>
                      <div className="geo-source-label">
                        <span className="geo-source-title">{item.label}</span>
                        <span className="geo-source-file">{item.file}</span>
                      </div>
                      <input
                        className="input input-mono geo-source-input"
                        value={urlDrafts[item.key]}
                        onChange={(e) =>
                          setUrlDrafts((prev) => ({ ...prev, [item.key]: e.target.value }))
                        }
                        onBlur={() => {
                          const url = urlDrafts[item.key].trim();
                          if (url === settings.geoUrls[item.key]) return;
                          updateSettings({
                            geoUrls: { ...settings.geoUrls, [item.key]: url },
                          });
                          notify('info', `${item.label} 在线源已保存`);
                        }}
                        spellCheck={false}
                        title={urlDrafts[item.key]}
                        aria-label={`${item.label} 在线源`}
                      />
                      <div className="geo-source-status">
                        <span className="geo-source-size">
                          {file ? formatSize(file.size) : '—'}
                        </span>
                        <Pill tone={file?.exists ? 'ok' : 'warn'}>
                          {file?.exists ? '就绪' : '缺失'}
                        </Pill>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={geoUpdating !== null}
                        onClick={() => void updateGeo(item.file)}
                      >
                        {geoUpdating === item.file ? <Spinner small /> : null}
                        更新
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="geo-options">
                <div className="geo-option">
                  <span>GeoData 模式</span>
                  <Segmented
                    ariaLabel="GeoData 模式"
                    options={[
                      { value: 'db', label: 'db' },
                      { value: 'dat', label: 'dat' },
                    ]}
                    value={settings.geoDataMode}
                    onChange={(v) => {
                      updateSettings({ geoDataMode: v as 'db' | 'dat' });
                      notify('info', 'GeoData 模式已保存，重启内核后生效');
                    }}
                  />
                </div>
                <div className="geo-option">
                  <span>自动更新</span>
                  <Toggle
                    on={settings.geoAutoUpdate}
                    onChange={(v) => {
                      updateSettings({ geoAutoUpdate: v });
                      notify('info', 'Geo 自动更新已保存');
                    }}
                    label="自动更新 Geo 数据"
                  />
                </div>
                {settings.geoAutoUpdate && (
                  <div className="geo-option">
                    <span>更新间隔</span>
                    <div className="geo-interval">
                      <input
                        className="input input-mono"
                        type="number"
                        min={1}
                        max={720}
                        value={settings.geoUpdateInterval}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isInteger(n) && n >= 1 && n <= 720) {
                            updateSettings({ geoUpdateInterval: n });
                          }
                        }}
                        aria-label="Geo 更新间隔小时"
                      />
                      <span>小时</span>
                    </div>
                  </div>
                )}
              </div>

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
