import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Segmented, Select, Spinner, Toggle } from '../components/ui';
import { IconChip, IconFolder, IconGlobe, IconRefresh } from '../components/icons';
import { api, DATA_DIR, type KernelInfo, type KernelVersionInfo } from '../core/api';
import { useApp, type OutboundMode } from '../store/app';

function Section({
  title,
  desc,
  icon,
  children,
}: {
  title: string;
  desc?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="section-head">
        {icon && <span className="icon-tile">{icon}</span>}
        <div className="section-head-text">
          <div className="section-title">{title}</div>
          {desc && <div className="section-desc">{desc}</div>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string;
  control: ReactNode;
}) {
  return (
    <div className="field-row">
      <div className="field-main">
        <div className="field-label">{label}</div>
        {hint && <div className="field-hint">{hint}</div>}
      </div>
      <div className="field-control">{control}</div>
    </div>
  );
}

const MODES: Array<{ value: OutboundMode; label: string }> = [
  { value: 'rule', label: '规则' },
  { value: 'global', label: '全局' },
  { value: 'direct', label: '直连' },
];

function shortVersion(value: string | null | undefined): string {
  if (!value) return '—';
  const match = /v?\d+\.\d+\.\d+/.exec(value);
  if (!match) return value;
  return match[0].startsWith('v') ? match[0] : `v${match[0]}`;
}

function PortField({
  value,
  onCommit,
  allowZero = false,
}: {
  value: number;
  onCommit: (n: number) => void;
  allowZero?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <input
      className="input input-mono"
      style={{ width: 110 }}
      value={draft}
      inputMode="numeric"
      aria-label="端口"
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={() => {
        const n = Number(draft);
        if (Number.isInteger(n) && n >= (allowZero ? 0 : 1) && n < 65536) {
          if (n !== value) onCommit(n);
        } else {
          setDraft(String(value));
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(String(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function KernelPage() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const notify = useApp((s) => s.notify);
  const kernelPhase = useApp((s) => s.kernelPhase);

  const [info, setInfo] = useState<KernelInfo | null>(null);
  const [versions, setVersions] = useState<KernelVersionInfo[]>([]);
  const [reinstalling, setReinstalling] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const running = kernelPhase === 'running';

  const loadVersions = async () => {
    try {
      const list = await api.listKernelVersions();
      setVersions(Array.isArray(list) ? list : []);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await api.kernelInfo();
        if (alive) setInfo(next);
      } catch {
        /* ignore */
      }
    };
    void load();
    void loadVersions();
    const timer = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const builtinVersion = versions.find((v) => v.builtin)?.version ?? '';
  const custom = settings.kernelPath;
  const versionOptions = [
    { value: '', label: `内置${builtinVersion ? ` ${shortVersion(builtinVersion)}` : ''}` },
    ...versions
      .filter((v) => !v.builtin)
      .map((v) => ({
        value: v.path,
        label: `${shortVersion(v.version)} · ${(v.size / 1024 / 1024).toFixed(0)} MB`,
      })),
    ...(custom && !versions.some((v) => v.path === custom)
      ? [{ value: custom, label: '自定义路径' }]
      : []),
  ];

  const downloadLatest = async () => {
    setDownloading(true);
    try {
      const proxyUrl =
        settings.githubProxy === 'auto' && running
          ? `http://127.0.0.1:${settings.mixedPort}`
          : undefined;
      const mirrorPrefix =
        settings.githubProxy && settings.githubProxy !== 'auto'
          ? settings.githubProxy
          : undefined;
      const v = await api.downloadKernelVersion(proxyUrl, mirrorPrefix);
      await loadVersions();
      updateSettings({ kernelPath: v.path });
      notify(
        'success',
        `已下载 ${shortVersion(v.version)}，重启内核后生效`
      );
    } catch (e) {
      notify('error', `下载失败：${String(e)}`);
    } finally {
      setDownloading(false);
    }
  };

  const changeRuntime = async (patch: Partial<typeof settings>, note: string) => {
    updateSettings(patch);
    const st = useApp.getState();
    await st.applyConfig();
    if (st.kernelPhase === 'running') {
      await st.restartKernel(true);
      st.notify('info', note);
    }
  };

  const changePorts = (patch: Partial<typeof settings>) =>
    changeRuntime(patch, '端口已更新，内核已重启');

  const restart = async () => {
    const st = useApp.getState();
    if (st.kernelPhase !== 'running') return;
    await st.restartKernel(true);
  };

  const reinstall = async () => {
    setReinstalling(true);
    try {
      const version = await api.reinstallResources();
      notify('success', `已重新解压：${shortVersion(version)}`);
    } catch (e) {
      notify('error', `解压失败：${String(e)}`);
    } finally {
      setReinstalling(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">内核</h1>
          <div className="page-sub">
            {shortVersion(info?.version ?? info?.bundledVersion ?? undefined)}
            {' · '}
            {info?.running ? '运行中' : '未运行'}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" disabled={!running} onClick={() => void restart()}>
            <IconRefresh size={13} />
            重启内核
          </button>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner kernel-page">
          <Section
            title="版本管理"
            desc="内置与已下载版本"
            icon={<IconChip size={15} />}
          >
            <Row
              label="使用版本"
              hint="重启后生效"
              control={
                <Select
                  value={settings.kernelPath}
                  options={versionOptions}
                  ariaLabel="内核版本"
                  onChange={(v) => {
                    updateSettings({ kernelPath: v });
                    if (running) notify('info', '重启后生效');
                  }}
                />
              }
            />
            <Row
              label="下载最新版"
              hint="使用设置里的下载代理"
              control={
                <button
                  type="button"
                  className="btn"
                  disabled={downloading}
                  onClick={() => void downloadLatest()}
                >
                  {downloading ? <Spinner small /> : null}
                  {downloading ? '下载中…' : '下载最新版'}
                </button>
              }
            />
          </Section>

          <Section title="内核状态" desc="" icon={<IconChip size={15} />}>
            <div className="kernel-stats">
              <div className="kernel-stat">
                <span className="kernel-stat-label">版本</span>
                <span className="kernel-stat-value">
                  {shortVersion(info?.version ?? info?.bundledVersion ?? undefined)}
                </span>
              </div>
              <div className="kernel-stat">
                <span className="kernel-stat-label">内存</span>
                <span className="kernel-stat-value">
                  {info?.rssKb ? `${(info.rssKb / 1024).toFixed(0)} MB` : '—'}
                </span>
              </div>
              <div className="kernel-stat">
                <span className="kernel-stat-label">状态</span>
                <span className="kernel-stat-value">{info?.running ? '运行中' : '未运行'}</span>
              </div>
            </div>
            <Row
              label="自定义内核路径"
              hint="留空使用内置"
              control={
                <input
                  className="input kernel-path-input"
                  defaultValue={settings.kernelPath}
                  key={settings.kernelPath}
                  placeholder="自动查找"
                  spellCheck={false}
                  aria-label="自定义内核路径"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== settings.kernelPath) updateSettings({ kernelPath: v });
                  }}
                />
              }
            />
            <Row
              label="数据目录"
              hint={`配置、日志与资源在 ${DATA_DIR}/`}
              control={
                <button
                  type="button"
                  className="btn"
                  onClick={() => void api.openDataDir(DATA_DIR)}
                >
                  <IconFolder size={13} />
                  在 Finder 打开
                </button>
              }
            />
          </Section>

          <Section
            title="网络"
            desc={running ? '改端口重启内核' : '端口、出站模式与局域网'}
            icon={<IconGlobe size={15} />}
          >
            <Row
              label="混合端口"
              hint="系统代理指向这里"
              control={
                <PortField
                  value={settings.mixedPort}
                  onCommit={(n) => void changePorts({ mixedPort: n })}
                />
              }
            />
            <Row
              label="控制端口"
              hint="API 端口"
              control={
                <PortField
                  value={settings.controllerPort}
                  onCommit={(n) => void changePorts({ controllerPort: n })}
                />
              }
            />
            <Row
              label="DNS 端口"
              hint="内核 DNS 监听端口，默认 1053"
              control={
                <PortField
                  value={settings.dnsPort}
                  onCommit={(n) =>
                    void changeRuntime({ dnsPort: n }, 'DNS 端口已更新，内核已重启')
                  }
                />
              }
            />
            <Row
              label="SOCKS 端口"
              hint="0 关闭"
              control={
                <PortField
                  value={settings.socksPort}
                  allowZero
                  onCommit={(n) => void changeRuntime({ socksPort: n }, '端口已更新，内核已重启')}
                />
              }
            />
            <Row
              label="HTTP 端口"
              hint="0 关闭"
              control={
                <PortField
                  value={settings.httpPort}
                  allowZero
                  onCommit={(n) => void changeRuntime({ httpPort: n }, '端口已更新，内核已重启')}
                />
              }
            />
            <Row
              label="Redir 端口"
              hint="0 关闭"
              control={
                <PortField
                  value={settings.redirPort}
                  allowZero
                  onCommit={(n) => void changeRuntime({ redirPort: n }, '端口已更新，内核已重启')}
                />
              }
            />
            <Row
              label="监听地址"
              hint="局域网填 0.0.0.0"
              control={
                <input
                  className="input input-mono"
                  style={{ width: 160 }}
                  defaultValue={settings.bindAddress}
                  key={settings.bindAddress}
                  spellCheck={false}
                  aria-label="监听地址"
                  onBlur={(e) => {
                    const v = e.target.value.trim() || '127.0.0.1';
                    if (v !== settings.bindAddress) {
                      void changeRuntime({ bindAddress: v }, '监听地址已更新，内核已重启');
                    }
                  }}
                />
              }
            />
            <Row
              label="用户认证"
              hint="留空不启用"
              control={
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="input"
                    style={{ width: 100 }}
                    defaultValue={settings.authUser}
                    key={`u-${settings.authUser}`}
                    placeholder="用户名"
                    aria-label="认证用户名"
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== settings.authUser) void changeRuntime({ authUser: v }, '认证已更新');
                    }}
                  />
                  <input
                    className="input"
                    style={{ width: 100 }}
                    type="password"
                    defaultValue={settings.authPass}
                    key={`p-${settings.authPass}`}
                    placeholder="密码"
                    aria-label="认证密码"
                    onBlur={(e) => {
                      const v = e.target.value;
                      if (v !== settings.authPass) void changeRuntime({ authPass: v }, '认证已更新');
                    }}
                  />
                </div>
              }
            />
            <Row
              label="出站模式"
              hint="规则 / 全局 / 直连"
              control={
                <Segmented
                  ariaLabel="出站模式"
                  options={MODES}
                  value={settings.mode}
                  onChange={(v) => void changeRuntime({ mode: v }, '出站模式已切换')}
                />
              }
            />
            <Row
              label="允许局域网连接"
              hint="同网段设备可用"
              control={
                <Toggle
                  on={settings.allowLan}
                  onChange={(v) => void changeRuntime({ allowLan: v }, '局域网访问已更新')}
                  label="允许局域网连接"
                />
              }
            />
          </Section>

          <Section
            title="内置资源"
            desc="内核与 Geo 数据"
            icon={<IconGlobe size={15} />}
          >
            <Row
              label="内置内核版本"
              hint=""
              control={<span className="card-hint">{shortVersion(info?.bundledVersion)}</span>}
            />
            <Row
              label="重新解压"
              hint="重新解压内置内核与 Geo"
              control={
                <button type="button" className="btn" disabled={reinstalling} onClick={() => void reinstall()}>
                  {reinstalling ? <Spinner small /> : null}
                  重新解压
                </button>
              }
            />
          </Section>
        </div>
      </div>
    </>
  );
}
