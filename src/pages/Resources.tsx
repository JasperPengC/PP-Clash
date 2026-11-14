import { useEffect, useRef, useState } from 'react';
import { EmptyState, Pill, ReadError, Segmented, Spinner, Toggle } from '../components/ui';
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
  onUpdateAll,
  query,
  busy,
}: {
  emptyTitle: string;
  emptyDesc: string;
  providers: Provider[];
  updating: string | null;
  onUpdate: (name: string) => Promise<void>;
  onUpdateAll: (names: string[]) => Promise<void>;
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
          <div className="dp-provider-columns" aria-hidden="true"><span>名称与类型</span><span>数量</span><span>上次更新</span><span>操作</span></div>
          {filtered.map((p) => (
            <div key={p.name} className="resource-provider">
              <div className="dp-provider-identity"><span className="resource-name" title={p.name}>{p.name}</span><span className="dp-provider-type">{p.vehicleType ?? p.type ?? 'provider'}</span></div>
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
        onClick={() => void onUpdateAll(filtered.map(p => p.name))}
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
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState({ files: false, rules: false, proxies: false });
  const [errors, setErrors] = useState({ files: '', rules: '', proxies: '' });
  const loadPending = useRef<Promise<boolean> | null>(null);
  const alive = useRef(true);
  const operation = useRef(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const [reinstallConfirm, setReinstallConfirm] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [geoUpdating, setGeoUpdating] = useState<string | null>(null);
  const [urlDrafts, setUrlDrafts] = useState(settings.geoUrls);
  const [tab, setTab] = useState<Tab>('geo');
  const [query, setQuery] = useState('');

  const load = (): Promise<boolean> => {
    if (loadPending.current) return loadPending.current;
    setLoading(true);
    const wasConnected = useApp.getState().kernelPhase === 'running';
    const readProviders = async (kind: 'rules' | 'proxies') => {
      if (!wasConnected) return [];
      const raw = await api.mihomo('GET', `/providers/${kind}`) as { providers?: Record<string, any> };
      if (!raw?.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) throw new Error('提供者响应格式异常');
      return Object.entries(raw.providers)
        .filter(([, p]) => kind !== 'proxies' || p?.vehicleType !== 'Compatible')
        .map(([name, p]) => ({ name, type: p?.type, vehicleType: p?.vehicleType,
          ruleCount: p?.ruleCount, count: Array.isArray(p?.proxies) ? p.proxies.length : undefined, updatedAt: p?.updatedAt }))
        .sort((a, b) => {
          const order: Record<string, number> = { File: 1, Inline: 2, HTTP: 3 };
          return (order[a.vehicleType ?? ''] ?? 4) - (order[b.vehicleType ?? ''] ?? 4);
        });
    };
    const pending = (async () => {
      const results = await Promise.allSettled([
        api.listResourceFiles().then(value => { if (!Array.isArray(value)) throw new Error('资源列表响应格式异常'); return value; }),
        readProviders('rules'), readProviders('proxies'),
      ]);
      if (!alive.current) return false;
      const nextErrors = { files: '', rules: '', proxies: '' };
      const nextLoaded: Partial<typeof loaded> = {};
      for (const [index, key] of (['files', 'rules', 'proxies'] as const).entries()) {
        const result = results[index];
        if (result.status === 'rejected') nextErrors[key] = String(result.reason);
        else {
          nextLoaded[key] = true;
          if (key === 'files') setFiles(result.value as ResourceFile[]);
          else if (key === 'rules') setRules(result.value as Provider[]);
          else setProxies(result.value as Provider[]);
        }
      }
      setErrors(nextErrors); setLoaded(previous => ({ ...previous, ...nextLoaded }));
      return results.every(result => result.status === 'fulfilled');
    })().finally(() => { loadPending.current = null; if (alive.current) setLoading(false); });
    loadPending.current = pending;
    return pending;
  };

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    if (loadPending.current) void loadPending.current.then(() => { if (!cancelled) void load(); });
    else void load();
    return () => { cancelled = true; };
  }, [connected]);

  const beginOperation = () => {
    if (operation.current || loadPending.current) return false;
    operation.current = true; setOperationBusy(true); return true;
  };
  const endOperation = () => { operation.current = false; setOperationBusy(false); };

  const reinstall = async () => {
    if (operation.current || loadPending.current) return;
    if (!reinstallConfirm) {
      setReinstallConfirm(true);
      window.setTimeout(() => setReinstallConfirm(false), 3000);
      return;
    }
    setReinstallConfirm(false);
    if (!beginOperation()) return;
    setReinstalling(true);
    try {
      await api.reinstallResources();
      const refreshed = await load();
      notify(refreshed ? 'success' : 'info', `内置数据已重新解压${refreshed ? '' : '，列表读取失败，请重试'}`);
    } catch (e) {
      notify('error', `解压失败：${String(e)}`);
    } finally {
      setReinstalling(false);
      endOperation();
    }
  };

  const updateProviders = async (kind: 'rules' | 'proxies', names: string[]) => {
    if (!beginOperation()) return;
    const failures: string[] = [];
    try {
      for (const name of names) {
        setUpdating(name);
        try { await api.mihomo('PUT', `/providers/${kind}/${encodeURIComponent(name)}`); }
        catch (error) { failures.push(`${name}：${String(error)}`); }
      }
      const refreshed = await load();
      if (failures.length) notify('error', `已更新 ${names.length - failures.length}/${names.length} 个提供者；失败：${failures.join('；')}`);
      else notify(refreshed ? 'success' : 'info', `已更新 ${names.length} 个提供者${refreshed ? '' : '，列表读取失败，请重试'}`);
    } finally {
      setUpdating(null);
      endOperation();
    }
  };

  const downloadGeo = async (name: string) => {
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
        throw new Error('没有配置在线源');
      }
      await api.downloadGeoResource(name, sourceUrl, proxyUrl, mirrorPrefix);
      return true;
    } catch (e) {
      notify('error', `更新 ${name} 失败：${String(e)}`);
      return false;
    } finally {
      setGeoUpdating(null);
    }
  };

  const updateGeo = async (names: string[]) => {
    if (!beginOperation()) return;
    try {
      let successes = 0;
      for (const name of names) if (await downloadGeo(name)) successes++;
      const refreshed = await load();
      if (successes) notify(successes === names.length && refreshed ? 'success' : 'info',
        `已更新 ${successes}/${names.length} 个数据文件，重启内核后生效${refreshed ? '' : '；列表读取失败，请重试'}`);
    } finally { endOperation(); }
  };

  const ready = files.filter((f) => f.exists).length;
  const tabs: Array<{ value: Tab; label: string; count?: number; error: string }> = [
    { value: 'geo', label: '内置数据', error: errors.files },
    { value: 'rules', label: '规则提供者', count: loaded.rules && !errors.rules ? rules.length : undefined, error: errors.rules },
    { value: 'proxies', label: '代理提供者', count: loaded.proxies && !errors.proxies ? proxies.length : undefined, error: errors.proxies },
  ];
  const failedResources = tabs.filter(resource => resource.error);

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">资源</h1>
          <div className="page-sub dp-resource-summary" aria-live="polite">
            {loading ? '正在读取资源…' : failedResources.length > 0 ? failedResources.map(resource => <button
              key={resource.value} type="button" className="link-action dp-resource-error-link"
              aria-label={`查看${resource.label}读取错误`} aria-controls="resource-panel"
              onClick={() => { setTab(resource.value); setQuery(''); }}
            >{resource.label}读取失败</button>)
              : `${ready}/${files.length} 个数据文件${connected ? ` · ${rules.length} 个规则集 · ${proxies.length} 个代理集` : ' · 内核未运行'}`}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="icon-btn" title="刷新资源" aria-label="刷新资源" aria-busy={loading} disabled={loading || operationBusy} onClick={() => void load()}>
            {loading ? <Spinner small /> : <IconRefresh size={15} />}
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

      <div className="page-scroll dp-page dp-resources">
        <div className="page-inner resources-page">
          <div className="resource-tabs" role="tablist" aria-label="资源类型">
            {tabs.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={tab === t.value}
                aria-controls="resource-panel"
                title={t.error ? `${t.label}读取失败：${t.error}` : undefined}
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
            <section id="resource-panel" className="card dp-resource-panel" role="tabpanel" aria-label="内置数据">
              <div className="section-head">
                <span className="dp-resource-heading-icon"><IconGlobe size={15} /></span>
                <div className="section-head-text">
                  <div className="section-title">内置数据</div>
                  <div className="section-desc">来源：MetaCubeX。在线更新会替换本地文件。</div>
                </div>
                <div className="spacer" />
                <button
                  type="button"
                  className="btn"
                  disabled={operationBusy || loading || !loaded.files || !!errors.files || files.length === 0}
                  onClick={() => void updateGeo(GEO_SOURCE_INFO.map(item => item.file))}
                >
                  {geoUpdating ? <Spinner small /> : <IconRefresh size={13} />}
                  在线更新
                </button>
                <button
                  type="button"
                  className={`btn${reinstallConfirm ? ' danger' : ''}`}
                  disabled={operationBusy || loading}
                  onClick={() => void reinstall()}
                >
                  {reinstalling ? <Spinner small /> : null}
                  {reinstallConfirm ? '确认恢复内置' : '恢复内置 Geo'}
                </button>
              </div>
              {errors.files && <ReadError message={`内置数据：${errors.files}${loaded.files ? '；以下显示上次读取结果' : ''}`} onRetry={() => void load()} busy={loading || operationBusy} />}
              {loading && !loaded.files && <EmptyState icon={<IconFolder size={19} />} title="正在读取内置数据…" loading />}
              <div className="geo-source-list">
                <div className="dp-geo-columns" aria-hidden="true"><span>数据库</span><span>在线源</span><span>本地状态</span><span>操作</span></div>
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
                        <Pill tone={!loaded.files || errors.files ? undefined : file?.exists ? 'ok' : 'warn'}>
                          {!loaded.files ? loading ? '读取中' : '未知' : errors.files ? '待确认' : file?.exists ? '就绪' : '缺失'}
                        </Pill>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={operationBusy || loading}
                        onClick={() => void updateGeo([item.file])}
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
            <section id="resource-panel" className="card dp-resource-panel" role="tabpanel" aria-label={tab === 'rules' ? '规则提供者' : '代理提供者'}>
              <div className="section-head">
                <span className="dp-resource-heading-icon"><IconFolder size={15} /></span>
                <div className="section-head-text">
                  <div className="section-title">
                    {tab === 'rules' ? '规则提供者' : '代理提供者'}
                  </div>
                  <div className="section-desc">
                    {tab === 'rules' ? '订阅中的规则集' : '订阅中的代理集'}
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
                  desc="连接后显示规则集与代理集"
                />
              ) : <>
                {errors[tab] && <ReadError message={`${tab === 'rules' ? '规则提供者' : '代理提供者'}：${errors[tab]}${loaded[tab] ? '；以下显示上次读取结果' : ''}`} onRetry={() => void load()} busy={loading || operationBusy} />}
                {loading && !loaded[tab] ? <EmptyState icon={<IconFolder size={19} />} title="正在读取提供者…" loading /> :
                  (!errors[tab] || (tab === 'rules' ? rules : proxies).length > 0) &&
                <ProviderList
                  emptyTitle={tab === 'rules' ? '没有规则提供者' : '没有代理提供者'}
                  emptyDesc={
                    tab === 'rules'
                      ? '当前订阅没有规则集'
                      : '当前订阅没有代理集'
                  }
                  providers={tab === 'rules' ? rules : proxies}
                  updating={updating}
                  busy={loading || operationBusy || !!errors[tab]}
                  query={query}
                  onUpdate={(name) => updateProviders(tab, [name])}
                  onUpdateAll={(names) => updateProviders(tab, names)}
                />
                }
              </>}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
