import { useEffect, useState } from 'react';
import { EmptyState, Pill, Spinner } from '../components/ui';
import { IconFolder, IconGlobe, IconRefresh } from '../components/icons';
import { api } from '../core/api';
import { formatTime } from '../core/format';
import { useApp } from '../store/app';

interface ResourceFile {
  name: string;
  size: number;
  exists: boolean;
}

interface RuleProvider {
  name: string;
  type?: string;
  vehicleType?: string;
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
  if (!value) return '';
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? '' : formatTime(ms);
}

export function ResourcesPage() {
  const connected = useApp((s) => s.kernelPhase === 'running');
  const notify = useApp((s) => s.notify);

  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [providers, setProviders] = useState<RuleProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const [reinstallConfirm, setReinstallConfirm] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const nextFiles = await api.listResourceFiles();
      setFiles(Array.isArray(nextFiles) ? nextFiles : []);
      if (connected) {
        const raw: any = await api.mihomo('GET', '/providers/rules');
        const map = raw?.providers ?? {};
        setProviders(
          Object.entries(map).map(([name, p]: [string, any]) => ({
            name,
            type: p?.type,
            vehicleType: p?.vehicleType,
            ruleCount: p?.ruleCount,
            updatedAt: p?.updatedAt,
          }))
        );
      } else {
        setProviders([]);
      }
    } catch {
      /* 内核未运行或预览环境时忽略 */
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

  const updateProvider = async (name: string) => {
    setUpdating(name);
    try {
      await api.mihomo('PUT', `/providers/rules/${encodeURIComponent(name)}`);
      notify('success', `已更新 ${name}`);
      await load();
    } catch (e) {
      notify('error', `更新失败：${String(e)}`);
    } finally {
      setUpdating(null);
    }
  };

  const updateAll = async () => {
    for (const p of providers) {
      // 顺序更新，避免大量并发请求打满内核
      // eslint-disable-next-line no-await-in-loop
      await updateProvider(p.name);
    }
  };

  const ready = files.filter((f) => f.exists).length;

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">资源</h1>
          <div className="page-sub">
            {files.length > 0
              ? `${ready} / ${files.length} 个数据文件就绪`
              : connected
                ? `${providers.length} 个规则提供者`
                : '内核未运行'}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" disabled={loading} onClick={() => void load()}>
            {loading ? <Spinner small /> : <IconRefresh size={13} />}
            刷新
          </button>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner">
          <section className="card">
            <div className="section-head">
              <span className="icon-tile">
                <IconGlobe size={15} />
              </span>
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
              <div className="rule-empty">{loading ? '读取中…' : '未找到数据文件'}</div>
            ) : (
              <div className="resource-list">
                {files.map((f) => {
                  const info = fileLabel(f.name);
                  return (
                    <div key={f.name} className="resource-file">
                      <span className="resource-file-icon">
                        <IconGlobe size={13} />
                      </span>
                      <span className="resource-file-main">
                        <span className="resource-name">{info.label}</span>
                        <span className="resource-file-note">
                          {f.name} · {info.note}
                        </span>
                      </span>
                      <span className="resource-size">{formatSize(f.size)}</span>
                      <Pill tone={f.exists ? 'ok' : 'warn'}>{f.exists ? '就绪' : '缺失'}</Pill>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card">
            <div className="section-head">
              <span className="icon-tile">
                <IconFolder size={15} />
              </span>
              <div className="section-head-text">
                <div className="section-title">规则提供者</div>
                <div className="section-desc">订阅里的 rule-providers</div>
              </div>
              <div className="spacer" />
              <button
                type="button"
                className="btn"
                disabled={!connected || providers.length === 0 || updating !== null}
                onClick={() => void updateAll()}
              >
                全部更新
              </button>
            </div>

            {!connected ? (
              <EmptyState
                icon={<IconFolder size={19} />}
                title="内核未运行"
                desc="开启接管后显示规则提供者。"
              />
            ) : providers.length === 0 ? (
              <EmptyState
                icon={<IconFolder size={19} />}
                title="没有规则提供者"
                desc="当前订阅未声明 rule-providers。"
              />
            ) : (
              <div className="resource-list">
                {providers.map((p) => (
                  <div key={p.name} className="resource-provider">
                    <span className="resource-name">{p.name}</span>
                    <span className="tag">{p.vehicleType ?? p.type ?? 'provider'}</span>
                    <span className="resource-meta">
                      {p.ruleCount != null ? `${p.ruleCount} 条` : '—'}
                    </span>
                    <span className="resource-meta resource-time">
                      {providerTime(p.updatedAt)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={updating !== null}
                      onClick={() => void updateProvider(p.name)}
                    >
                      {updating === p.name ? <Spinner small /> : null}
                      更新
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
