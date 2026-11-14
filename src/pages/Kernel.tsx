import { useEffect, useId, useRef, useState } from 'react';
import { startPolling } from '../core/polling';
import type { ReactNode } from 'react';
import { EmptyState, ReadError, Segmented, Select, Spinner, Toggle } from '../components/ui';
import { IconChip, IconFolder, IconRefresh, IconTun } from '../components/icons';
import { api, DATA_DIR, type HelperInfo, type KernelInfo, type KernelVersionInfo } from '../core/api';
import { getLifecycleToken, isLifecycleCurrent, useApp, type OutboundMode } from '../store/app';
import { isLoopbackAddress } from '../core/listen-address';

function Section({
  title,
  desc,
  children,
  className = '',
}: {
  title: string;
  desc?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`configuration-section ${className}`.trim()} aria-label={title}>
      <div className="configuration-section-head">
        <h2 className="section-title">{title}</h2>
        {desc && <p className="configuration-description">{desc}</p>}
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
  const id = useId();
  return (
    <div className="field-row" role="group" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}>
      <div className="field-main">
        <div className="field-label" id={`${id}-label`}>{label}</div>
        {hint && <div className="field-hint" id={`${id}-hint`}>{hint}</div>}
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
  label,
  value,
  onCommit,
  allowZero = false,
  disabled = false,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => Promise<boolean>;
  allowZero?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <input
      className="input input-mono"
      disabled={disabled}
      style={{ width: 110 }}
      value={draft}
      inputMode="numeric"
      aria-label={label}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={async () => {
        const n = Number(draft);
        if (Number.isInteger(n) && n >= (allowZero ? 0 : 1) && n < 65536) {
          if (n !== value && !await onCommit(n)) setDraft(String(value));
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

export function KernelPage({ active = true }: { active?: boolean }) {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const notify = useApp((s) => s.notify);
  const kernelPhase = useApp((s) => s.kernelPhase);

  const [info, setInfo] = useState<KernelInfo | null>(null);
  const [versions, setVersions] = useState<KernelVersionInfo[]>([]);
  const [reinstalling, setReinstalling] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [helper, setHelper] = useState<HelperInfo | null>(null);
  const [helperBusy, setHelperBusy] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [errors, setErrors] = useState({ info: '', versions: '', helper: '' });
  const [loading, setLoading] = useState({ info: true, versions: true, helper: true });
  const [versionsLoaded, setVersionsLoaded] = useState(false);
  const pendingReads = useRef<Partial<Record<'info' | 'versions' | 'helper', Promise<void>>>>({});
  const alive = useRef(true);
  const operation = useRef(false);
  const [operationBusy, setOperationBusy] = useState(false);

  const running = kernelPhase === 'running';

  const load = (kind: 'info' | 'versions' | 'helper'): Promise<void> => {
    if (pendingReads.current[kind]) return pendingReads.current[kind]!;
    setLoading(previous => ({ ...previous, [kind]: true }));
    const request = (async () => {
      try {
        if (kind === 'info') {
          const value = await api.kernelInfo();
          if (!value || typeof value.running !== 'boolean') throw new Error('内核状态响应格式异常');
          if (alive.current) setInfo(value);
        } else if (kind === 'versions') {
          const value = await api.listKernelVersions();
          if (!Array.isArray(value)) throw new Error('版本列表响应格式异常');
          if (alive.current) { setVersions(value); setVersionsLoaded(true); }
        } else {
          const value = await api.systemHelperInfo();
          if (!value || typeof value.installed !== 'boolean') throw new Error('提权内核响应格式异常');
          if (alive.current) setHelper(value);
        }
        if (alive.current) setErrors(previous => ({ ...previous, [kind]: '' }));
      } catch (error) {
        if (alive.current) setErrors(previous => ({ ...previous, [kind]: String(error) }));
      } finally {
        delete pendingReads.current[kind];
        if (alive.current) setLoading(previous => ({ ...previous, [kind]: false }));
      }
    })();
    pendingReads.current[kind] = request;
    return request;
  };
  const refresh = () => Promise.all([load('info'), load('versions'), load('helper')]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!active) return;
    void load('versions'); void load('helper');
    return startPolling(() => operation.current ? undefined : load('info'), 5000);
  }, [active]);
  const beginOperation = () => {
    if (operation.current || ['starting', 'stopping'].includes(useApp.getState().kernelPhase)) return false;
    operation.current = true; setOperationBusy(true); return true;
  };
  const endOperation = () => { operation.current = false; setOperationBusy(false); };
  const settleReads = () => Promise.all(Object.values(pendingReads.current));
  const reading = Object.values(loading).some(Boolean);
  const busy = operationBusy || kernelPhase === 'starting' || kernelPhase === 'stopping';
  const lanAuthReady = Boolean(settings.authUser.trim() && settings.authPass.trim());
  const lanListenReady = Boolean(settings.bindAddress.trim()) && !isLoopbackAddress(settings.bindAddress);
  const lanReady = lanAuthReady && lanListenReady;
  const statusLabel = info ? (info.running ? '运行中' : '未运行') : loading.info ? '读取中…' : '状态未知';

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
    if (!beginOperation()) return;
    setDownloading(true);
    try {
      await settleReads();
      const proxyUrl =
        settings.githubProxy === 'auto' && running
          ? `http://127.0.0.1:${settings.mixedPort}`
          : undefined;
      const mirrorPrefix =
        settings.githubProxy && settings.githubProxy !== 'auto'
          ? settings.githubProxy
          : undefined;
      const v = await api.downloadKernelVersion(proxyUrl, mirrorPrefix);
      await load('versions');
      updateSettings({ kernelPath: v.path });
      notify(
        'success',
        `已下载 ${shortVersion(v.version)}，重启内核后生效`
      );
    } catch (e) {
      notify('error', `下载失败：${String(e)}`);
    } finally {
      setDownloading(false);
      endOperation();
    }
  };

  const changeRuntime = async (patch: Partial<typeof settings>, note: string) => {
    if (!beginOperation()) return false;
    const token = getLifecycleToken();
    let previous: Partial<typeof settings> | null = null;
    try {
      await settleReads();
      if (!isLifecycleCurrent(token)) return false;
      const current = useApp.getState();
      previous = Object.fromEntries(Object.keys(patch).map(key => [key, current.settings[key as keyof typeof settings]]));
      updateSettings(patch);
      const st = useApp.getState();
      if (st.kernelPhase !== 'running' && !st.profiles.some(profile => profile.id === st.activeId)) {
        st.notify('info', '设置已保存，导入并启用订阅后生效');
        return true;
      }
      const applied = await st.applyConfig();
      if (!isLifecycleCurrent(token)) return false;
      if (!applied) throw new Error('配置生成失败，原设置已恢复');
      if (st.kernelPhase === 'running') {
        if (!await st.restartKernel(true, token, true)) throw new Error('内核重启失败，原设置已恢复');
        if (!isLifecycleCurrent(token)) return false;
        st.notify('info', note);
      } else st.notify('info', '设置已保存，下次启动生效');
      return true;
    } catch (error) {
      if (!isLifecycleCurrent(token)) return false;
      if (previous) { updateSettings(previous); useApp.setState({ configPath: '' }); }
      notify('error', `设置应用失败：${String(error)}`);
      return false;
    }
    finally { endOperation(); }
  };

  const changePorts = (patch: Partial<typeof settings>) =>
    changeRuntime(patch, '端口已更新，内核已重启');

  const restart = async () => {
    const st = useApp.getState();
    if (st.kernelPhase !== 'running' || !beginOperation()) return;
    const token = getLifecycleToken();
    try { await settleReads(); if (isLifecycleCurrent(token) && await st.restartKernel(true, token)) await refresh(); }
    catch (error) { notify('error', `重启失败：${String(error)}`); }
    finally { endOperation(); }
  };

  const reinstall = async () => {
    if (!beginOperation()) return;
    setReinstalling(true);
    try {
      await settleReads();
      const version = await api.reinstallResources();
      await refresh();
      notify('success', `已重新解压：${shortVersion(version)}`);
    } catch (e) {
      notify('error', `解压失败：${String(e)}`);
    } finally {
      setReinstalling(false);
      endOperation();
    }
  };

  const installHelper = async () => {
    if (!beginOperation()) return;
    setHelperBusy(true);
    try {
      await settleReads();
      const installed = await api.installSystemHelper();
      setHelper(installed);
      if (!installed?.installed) throw new Error('未确认安装完成，请刷新状态后重试');
      setErrors(previous => ({ ...previous, helper: '' }));
      notify('success', 'TUN 提权内核已安装');
    } catch (e) {
      notify('error', `安装失败：${String(e)}`);
    } finally {
      setHelperBusy(false);
      endOperation();
    }
  };

  const uninstallHelper = async () => {
    if (operation.current) return;
    if (!confirmUninstall) {
      setConfirmUninstall(true);
      window.setTimeout(() => setConfirmUninstall(false), 3000);
      return;
    }
    setConfirmUninstall(false);
    if (!beginOperation()) return;
    setHelperBusy(true);
    try {
      await settleReads();
      const uninstalled = await api.uninstallSystemHelper();
      setHelper(uninstalled);
      if (!uninstalled || uninstalled.installed) throw new Error('未确认卸载完成，请刷新状态后重试');
      setErrors(previous => ({ ...previous, helper: '' }));
      notify('success', '提权内核已卸载，TUN 将回退到系统授权启动');
    } catch (e) {
      notify('error', `卸载失败：${String(e)}`);
    } finally {
      setHelperBusy(false);
      endOperation();
    }
  };

  return (
    <>
      <header className="page-head page-head-wide">
        <div className="page-heading">
          <h1 className="page-title">内核</h1>
          <div className="page-sub">
            {shortVersion(info?.version ?? info?.bundledVersion ?? undefined)}
            {' · '}
            {statusLabel}{errors.info && info ? ' · 上次读取结果' : ''}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="icon-btn" title="刷新内核状态" aria-label="刷新内核状态" aria-busy={reading} disabled={reading || operationBusy} onClick={() => void refresh()}>
            {reading ? <Spinner small /> : <IconRefresh size={15} />}
          </button>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner configuration-page kernel-configuration">
          {errors.info && <ReadError message={`内核状态：${errors.info}${info ? '；以下显示上次读取结果' : ''}`} onRetry={() => void load('info')} busy={loading.info || operationBusy} />}
          {loading.info && !info && <EmptyState icon={<IconChip size={19} />} title="正在读取内核状态…" loading />}
          <section className="configuration-runtime" aria-label="内核运行状态">
            <div className="kernel-runtime-main">
              <div className="kernel-runtime-title">
                <h2 className="section-title">mihomo {shortVersion(info?.version ?? info?.bundledVersion ?? undefined)}</h2>
                <span className={`configuration-state${errors.info ? ' warn' : info?.running ? ' ok' : ''}`}>{statusLabel}</span>
              </div>
              <div className="kernel-runtime-path">
                {info?.pid ? <span>PID {info.pid}</span> : null}
                <span>{info?.binary ?? '尚未读取到内核路径'}</span>
              </div>
            </div>
            <div className="kernel-runtime-facts">
              <div>
                <span>内存</span>
                <strong>{info?.rssKb ? `${(info.rssKb / 1024).toFixed(0)} MB` : '—'}</strong>
              </div>
            </div>
            <div className="kernel-runtime-actions">
              <button type="button" className="btn" disabled={!running || busy} onClick={() => void restart()}>
                <IconRefresh size={13} />重启
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void downloadLatest()}>
                {downloading ? <Spinner small /> : null}
                {downloading ? '下载中…' : '下载最新'}
              </button>
            </div>
          </section>

          <div className="configuration-sheet">
          <Section
            title="版本与文件"
            desc="选择内核版本、指定文件位置并管理内置资源"
          >
            {errors.versions && <ReadError message={`版本列表：${errors.versions}${versionsLoaded ? '；以下显示上次读取结果' : ''}`} onRetry={() => void load('versions')} busy={loading.versions || operationBusy} />}
            {loading.versions && !versionsLoaded && <EmptyState icon={<IconChip size={19} />} title="正在读取版本列表…" loading />}
            <Row
              label="使用版本"
              hint="重启后生效"
              control={
                <Select
                  value={settings.kernelPath}
                  options={versionOptions}
                  ariaLabel="内核版本"
                  disabled={busy || loading.versions || !!errors.versions}
                  onChange={(v) => {
                    updateSettings({ kernelPath: v });
                    if (running) notify('info', '重启后生效');
                  }}
                />
              }
            />

            <Row
              label="自定义内核路径"
              hint="留空使用内置"
              control={
                <input
                  className="input kernel-path-input"
                  disabled={busy}
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
                  onClick={() => void api.openDataDir(DATA_DIR).catch(error => notify('error', `打开目录失败：${String(error)}`))}
                >
                  <IconFolder size={13} />
                  在 Finder 打开
                </button>
              }
            />

            <Row
              label="内置内核版本"
              hint=""
              control={<span className="card-hint">{shortVersion(info?.bundledVersion)}</span>}
            />
            <Row
              label="重新解压"
              hint="重新解压内置内核与 Geo"
              control={
                <button type="button" className="btn" disabled={busy} onClick={() => void reinstall()}>
                  {reinstalling ? <Spinner small /> : null}
                  重新解压
                </button>
              }
            />
          </Section>

          <Section
            className="kernel-network"
            title="运行参数"
            desc={running ? '修改端口会重启内核' : '端口、出站模式与局域网'}
          >
            <Row
              label="混合端口"
              hint="系统代理指向这里"
              control={
                <PortField
                  label="混合端口"
                  disabled={busy}
                  value={settings.mixedPort}
                  onCommit={(n) => changePorts({ mixedPort: n })}
                />
              }
            />
            <Row
              label="控制端口"
              hint="API 端口"
              control={
                <PortField
                  label="控制端口"
                  disabled={busy}
                  value={settings.controllerPort}
                  onCommit={(n) => changePorts({ controllerPort: n })}
                />
              }
            />
            <Row
              label="DNS 端口"
              hint="内核 DNS 监听端口，默认 1053"
              control={
                <PortField
                  label="DNS 端口"
                  disabled={busy}
                  value={settings.dnsPort}
                  onCommit={(n) =>
                    changeRuntime({ dnsPort: n }, 'DNS 端口已更新，内核已重启')
                  }
                />
              }
            />
            <Row
              label="SOCKS 端口"
              hint="0 关闭"
              control={
                <PortField
                  label="SOCKS 端口"
                  disabled={busy}
                  value={settings.socksPort}
                  allowZero
                  onCommit={(n) => changeRuntime({ socksPort: n }, '端口已更新，内核已重启')}
                />
              }
            />
            <Row
              label="HTTP 端口"
              hint="0 关闭"
              control={
                <PortField
                  label="HTTP 端口"
                  disabled={busy}
                  value={settings.httpPort}
                  allowZero
                  onCommit={(n) => changeRuntime({ httpPort: n }, '端口已更新，内核已重启')}
                />
              }
            />
            <Row
              label="Redir 端口"
              hint="0 关闭"
              control={
                <PortField
                  label="Redir 端口"
                  disabled={busy}
                  value={settings.redirPort}
                  allowZero
                  onCommit={(n) => changeRuntime({ redirPort: n }, '端口已更新，内核已重启')}
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
                  disabled={busy}
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
                    disabled={busy}
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
                    disabled={busy}
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
                  disabled={busy}
                  options={MODES}
                  value={settings.mode}
                  onChange={(v) => void changeRuntime({ mode: v }, '出站模式已切换')}
                />
              }
            />
            <Row
              label="允许局域网连接"
              hint={!lanAuthReady ? '先填写认证用户名和密码' : !lanListenReady ? '先将监听地址设为 0.0.0.0 或本机局域网地址' : '允许同一局域网的设备使用代理'}
              control={
                <Toggle
                  on={settings.allowLan && lanReady}
                  onChange={(v) => void changeRuntime({ allowLan: v }, '局域网访问已更新')}
                  label="允许局域网连接"
                  disabled={busy || !lanReady}
                />
              }
            />
          </Section>

          <Section
            title="系统服务"
            desc="管理 TUN 提权内核；安装和卸载需要系统授权"
          >
            {errors.helper && <ReadError message={`提权内核：${errors.helper}${helper ? '；以下显示上次读取结果' : ''}`} onRetry={() => void load('helper')} busy={loading.helper || operationBusy} />}
            {loading.helper && !helper && <EmptyState icon={<IconTun size={19} />} title="正在读取提权内核…" loading />}
            <Row
              label="状态"
              hint={
                !helper ? (loading.helper ? '正在读取安装状态' : '安装状态未知，请重试') : helper.installed
                  ? `已安装${helper.version ? ` · ${helper.version}` : ''}${helper.needsUpdate ? ' · 需要更新' : ''}`
                  : '未安装；TUN 将使用系统授权启动'
              }
              control={
                <span className={`configuration-state ${helper?.installed ? (helper.needsUpdate ? 'warn' : 'ok') : ''}`}>
                  {!helper ? (loading.helper ? '读取中' : '未知') : helper.installed ? (helper.needsUpdate ? '需要更新' : '已安装') : '未安装'}
                </span>
              }
            />
            <Row
              label="安装 / 更新"
              hint="需要管理员授权"
              control={
                <button
                  type="button"
                  className="btn"
                  disabled={busy || loading.helper || !!errors.helper || !helper}
                  onClick={() => void installHelper()}
                >
                  {helperBusy ? <Spinner small /> : null}
                  {helperBusy ? '处理中…' : helper?.needsUpdate ? '更新' : '安装'}
                </button>
              }
            />
            <Row
              label="卸载"
              hint="移除后，开启 TUN 需重新授权"
              control={
                <button
                  type="button"
                  className={`btn btn-ghost${confirmUninstall ? ' danger' : ''}`}
                  disabled={busy || loading.helper || !!errors.helper || !helper?.installed}
                  onClick={() => void uninstallHelper()}
                >
                  {confirmUninstall ? '确认卸载' : '卸载'}
                </button>
              }
            />
            <Row
              label="系统路径"
              hint="仅 root 可写"
              control={<span className="card-hint input-mono">{helper?.path ?? '—'}</span>}
            />
          </Section>
          </div>


        </div>
      </div>
    </>
  );
}
