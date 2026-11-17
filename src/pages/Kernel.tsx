import { useEffect, useId, useRef, useState } from 'react';
import { startPolling } from '../core/polling';
import type { ReactNode } from 'react';
import { EmptyState, ReadError, Select, Spinner, Toggle } from '../components/ui';
import { KernelVersionPicker } from '../components/KernelVersionPicker';
import { Dialog } from '../components/Dialog';
import { AnimatedDetails } from '../components/AnimatedDetails';
import { IconCheck, IconChevronDown, IconDownload, IconFolder, IconRefresh, IconTrash, IconX } from '../components/icons';
import { api, DATA_DIR, type HelperInfo, type KernelInfo, type KernelVersionInfo } from '../core/api';
import { getLifecycleToken, isLifecycleCurrent, useApp } from '../store/app';
import { isLoopbackAddress } from '../core/listen-address';
import { isLinux } from '../core/platform';

function Section({
  title,
  desc,
  children,
  className = '',
  action,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <section className={`configuration-section ${className}`.trim()} aria-label={title}>
      <div className="configuration-section-head">
        <div>
          <h2 className="section-title">{title}</h2>
          {desc && <p className="configuration-description">{desc}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  control,
  className = '',
  action,
}: {
  label: string;
  hint?: string;
  control: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={`field-row ${className}`.trim()} role="group" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}>
      <div className="field-main">
        <div className="kernel-field-heading"><div className="field-label" id={`${id}-label`}>{label}</div>{action}</div>
        {hint && <div className="field-hint" id={`${id}-hint`}>{hint}</div>}
      </div>
      <div className="field-control">{control}</div>
    </div>
  );
}

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
      className="input input-mono kernel-port-input"
      disabled={disabled}
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

function OptionalPortField({ label, value, defaultPort, disabled, onCommit }: {
  label: string; value: number; defaultPort: number; disabled: boolean; onCommit: (n: number) => Promise<boolean>;
}) {
  const [remembered, setRemembered] = useState(value || defaultPort);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  useEffect(() => { if (value > 0) setRemembered(value); }, [value]);
  const commit = async (n: number) => {
    if (lock.current || disabled) return false;
    lock.current = true; setPending(true);
    try {
      const ok = await onCommit(n);
      if (ok && n > 0) setRemembered(n);
      return ok;
    } finally { lock.current = false; setPending(false); }
  };
  return <Row label={label} hint={value > 0 ? '已启用' : '关闭时不监听'}
    action={<Toggle on={value > 0} disabled={disabled || pending} label={`启用 ${label}`}
      onChange={enabled => { void commit(enabled ? remembered : 0); }} />}
    control={<PortField label={label} value={value || remembered} disabled={disabled || pending || value === 0} onCommit={commit} />} />;
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
  const [downloadChannel, setDownloadChannel] = useState<'stable' | 'preview' | 'specific'>('stable');
  const [specificVersion, setSpecificVersion] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [localVersionsOpen, setLocalVersionsOpen] = useState(false);
  const localVersionsHeading = useId();
  const [deleteVersion, setDeleteVersion] = useState('');
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
  const endOperation = () => { operation.current = false; if (alive.current) setOperationBusy(false); };
  const settleReads = () => Promise.all(Object.values(pendingReads.current));
  const reading = Object.values(loading).some(Boolean);
  const busy = operationBusy || kernelPhase === 'starting' || kernelPhase === 'stopping';
  const lanAuthReady = Boolean(settings.authUser.trim() && settings.authPass.trim());
  const lanListenReady = Boolean(settings.bindAddress.trim()) && !isLoopbackAddress(settings.bindAddress);
  const lanReady = lanAuthReady && lanListenReady;
  const selectedVersion = versions.find(version => settings.kernelPath ? version.path === settings.kernelPath : version.builtin);
  const versionOptions = versions.map(version => ({
    value: version.builtin ? '' : version.path,
    label: `${shortVersion(version.version)} · ${version.builtin ? '内置' : '本地'}`,
  }));
  if (settings.kernelPath && !selectedVersion) versionOptions.push({ value: settings.kernelPath, label: '自定义路径' });
  const downloadInstalled = downloadChannel === 'specific' && versions.some(version => shortVersion(version.version) === shortVersion(specificVersion));
  const downloadTag = downloadChannel === 'preview' ? 'Prerelease-Alpha' : downloadChannel === 'specific' ? specificVersion : undefined;
  const downloadLabel = downloadChannel === 'preview' ? '下载预览版' : downloadChannel === 'specific' ? `下载 ${specificVersion}` : '下载稳定版';
  const statusLabel = info ? (info.running ? '运行中' : '未运行') : loading.info ? '读取中…' : '状态未知';

  const downloadProxy = () => {
    const current = useApp.getState();
    return current.settings.githubProxy === 'auto' && current.kernelPhase === 'running'
      ? `http://127.0.0.1:${current.settings.mixedPort}` : undefined;
  };
  const downloadLatest = async (version?: string) => {
    if (!beginOperation()) return;
    setDownloading(true);
    try {
      await settleReads();
      const proxyUrl = downloadProxy();
      const mirrorPrefix =
        settings.githubProxy && settings.githubProxy !== 'auto'
          ? settings.githubProxy
          : undefined;
      const v = await api.downloadKernelVersion(proxyUrl, mirrorPrefix, version);
      await load('versions');
      if (!alive.current) return;
      notify(
        'success',
        `已下载 ${shortVersion(v.version)}，可在「使用版本」中切换`
      );
    } catch (e) {
      notify('error', `下载失败：${String(e)}`);
    } finally {
      if (alive.current) setDownloading(false);
      endOperation();
    }
  };

  const removeVersion = async (version: KernelVersionInfo) => {
    const current = useApp.getState();
    if (version.builtin || current.settings.kernelPath === version.path || info?.binary === version.path || !beginOperation()) return;
    try {
      await api.removeKernelVersion(version.path);
      await load('versions');
      if (alive.current) { setDeleteVersion(''); notify('success', `已删除 ${shortVersion(version.version)}`); }
    } catch (error) { notify('error', `删除失败：${String(error)}`); }
    finally { endOperation(); }
  };

  const changeRuntime = async (patch: Partial<typeof settings>, note: string) => {
    if (!beginOperation()) return false;
    const token = getLifecycleToken();
    try {
      await settleReads();
      if (!isLifecycleCurrent(token)) return false;
      const result = await useApp.getState().applyRuntimeSettings(patch, {
        allowRunningWithoutProfile: true,
        rollback: { config: true, restart: 'always', exception: true },
      });
      if (result.status === 'stale') return false;
      if (result.status === 'failed') {
        const message = result.stage === 'config' ? '配置生成失败，原设置已恢复'
          : result.stage === 'restart' ? '内核重启失败，原设置已恢复' : String(result.error);
        throw new Error(message);
      }
      notify('info', result.status === 'deferred' ? '设置已保存，导入并启用订阅后生效'
        : result.status === 'applied' ? note : '设置已保存，下次启动生效');
      return true;
    } catch (error) {
      if (!isLifecycleCurrent(token)) return false;
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
      if (!installed?.installed) throw new Error(isLinux ? '未确认授权完成，请刷新状态后重试' : '未确认安装完成，请刷新状态后重试');
      setErrors(previous => ({ ...previous, helper: '' }));
      notify('success', isLinux ? 'TUN 网络授权已就绪' : helper?.installed ? 'TUN 提权服务已重新安装' : 'TUN 提权服务已安装');
    } catch (e) {
      notify('error', `${isLinux ? '授权失败' : '安装失败'}：${String(e)}`);
      await load('helper');
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
      if (!uninstalled || uninstalled.installed) throw new Error(isLinux ? '未确认移除授权，请刷新状态后重试' : '未确认卸载完成，请刷新状态后重试');
      setErrors(previous => ({ ...previous, helper: '' }));
      notify('success', isLinux ? '网络授权已移除，下次开启 TUN 时重新授权' : '提权内核已卸载，TUN 将回退到系统授权启动');
    } catch (e) {
      notify('error', `${isLinux ? '移除授权失败' : '卸载失败'}：${String(e)}`);
      await load('helper');
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
          {loading.info && !info && <EmptyState compact title="正在读取内核状态…" loading />}
          <section className="configuration-runtime" aria-label="内核运行状态">
            <div className="kernel-runtime-main">
              <div className="kernel-runtime-title">
                <h2 className="section-title">mihomo <span>{shortVersion(info?.running ? info.version : (settings.kernelPath ? versions.find(v => v.path === settings.kernelPath)?.version : info?.bundledVersion))}</span></h2>
                <span className={`configuration-state${errors.info ? ' warn' : info?.running ? ' ok' : ''}`}>{statusLabel}</span>
              </div>
              <div className="kernel-runtime-facts">
                <span>内存 <strong>{info?.rssKb ? `${(info.rssKb / 1024).toFixed(0)} MB` : '—'}</strong></span>
                {info?.pid ? <span>PID <strong>{info.pid}</strong></span> : null}
                {errors.info && info && <span className="configuration-warning">上次读取结果</span>}
              </div>
            </div>
            <div className="kernel-runtime-actions">
              <button type="button" className="btn" disabled={!running || busy} onClick={() => void restart()}>
                <IconRefresh size={13} />重启
              </button>
            </div>
            <div className="kernel-runtime-path" title={info?.binary ?? undefined}>
              <span>运行文件</span><span>{info?.binary ?? '尚未读取到内核路径'}</span>
            </div>
          </section>

          <div className="kernel-management-grid">
            <Section
              className="kernel-version-section"
              title="版本管理"
              action={<button type="button" className="link-action" disabled={busy} aria-label="选择特定版本" onClick={() => setPickerOpen(true)}>选择特定版本</button>}
            >
              {errors.versions && <ReadError message={`版本列表：${errors.versions}${versionsLoaded ? '；以下显示上次读取结果' : ''}`} onRetry={() => void load('versions')} busy={loading.versions || operationBusy} />}
              {loading.versions && !versionsLoaded && <EmptyState compact title="正在读取版本列表…" loading />}
              <Row label="使用版本" className="kernel-download-field"
                hint={selectedVersion
                  ? `${selectedVersion.builtin ? '内置' : '本地'} · ${(selectedVersion.size / 1024 / 1024).toFixed(0)} MB${info?.running && info.binary === selectedVersion.path ? ' · 运行中' : running ? ' · 重启后生效' : ' · 下次启动生效'}`
                  : settings.kernelPath ? '自定义内核' : undefined}
                control={<>
                  <Select value={selectedVersion?.builtin ? '' : settings.kernelPath} ariaLabel="使用版本"
                    disabled={busy || loading.versions || !!errors.versions || !versionOptions.length}
                    options={versionOptions}
                    onChange={path => {
                      if (path === (selectedVersion?.builtin ? '' : settings.kernelPath)) return;
                      updateSettings({ kernelPath: path }); setDeleteVersion('');
                      notify('info', running ? '已选用，重启内核后生效' : '已选用，下次启动生效');
                    }} />
                  <button type="button" className="icon-btn" aria-label="管理本地版本" title="管理本地版本"
                    disabled={busy || loading.versions || !!errors.versions || !versions.length}
                    onClick={() => { setDeleteVersion(''); setLocalVersionsOpen(true); }}><IconFolder size={15} /></button>
                </>} />
              <Row label="更新通道" className="kernel-download-field"
                hint={downloadChannel === 'stable' ? '推荐日常使用' : downloadChannel === 'preview' ? '包含尚未正式发布的更新' : specificVersion}
                control={<>
                  <Select value={downloadChannel} ariaLabel="内核更新通道" disabled={busy}
                    options={[{ value: 'stable', label: '稳定版' }, { value: 'preview', label: '预览版' }, { value: 'specific', label: '特定版本' }]}
                    onChange={value => { if (value === 'specific') setPickerOpen(true); else setDownloadChannel(value); }} />
                  <button type="button" className="icon-btn" aria-label={downloadLabel} title={downloadInstalled ? '此版本已安装' : downloadLabel}
                    disabled={busy || downloadInstalled || (downloadChannel === 'specific' && !specificVersion)}
                    onClick={() => void downloadLatest(downloadTag)}>
                    {downloading ? <Spinner small /> : <IconDownload size={15} />}
                  </button>
                </>} />


              <Row
                label="自定义内核路径"
                hint="留空使用内置"
                className="kernel-path-field"
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
                    className="icon-btn"
                    aria-label="打开数据目录"
                    title="打开数据目录"
                    onClick={() => void api.openDataDir(DATA_DIR).catch(error => notify('error', `打开目录失败：${String(error)}`))}
                  >
                    <IconFolder size={15} />
                  </button>
                }
              />

              <Row
                label="内置资源"
                hint={`${shortVersion(info?.bundledVersion)} · 内核与 Geo`}
                control={
                  <button type="button" className="btn" disabled={busy} onClick={() => void reinstall()}>
                    {reinstalling ? <Spinner small /> : null}
                    重新解压
                  </button>
                }
              />
            </Section>

            <Section
              className="kernel-service-section"
              title={isLinux ? '网络授权' : '系统服务'}
              action={<button type="button" className="icon-btn" aria-label="检查服务状态" title="检查服务状态"
                aria-busy={loading.helper} disabled={busy || loading.helper} onClick={() => void load('helper')}>
                {loading.helper ? <Spinner small /> : <IconRefresh size={15} />}
              </button>}
            >
              {errors.helper && <ReadError message={`提权内核：${errors.helper}${helper ? '；以下显示上次读取结果' : ''}`} onRetry={() => void load('helper')} busy={loading.helper || operationBusy} />}
              <Row
                label={isLinux ? 'TUN 网络授权' : 'TUN 提权服务'}
                className="kernel-helper-management"
                hint={helper?.installed && helper.version ? helper.version : isLinux ? '内核以当前用户运行，仅授予网络能力' : '用于 TUN 模式'}
                action={
                  <span role="status" className={`configuration-state ${loading.helper || errors.helper || !helper ? '' : helper.installed ? (helper.needsUpdate ? 'warn' : 'ok') : ''}`}>
                    {loading.helper ? '检查中…' : errors.helper || !helper ? '状态未知' : helper.installed ? (helper.needsUpdate ? '待更新' : isLinux ? '已授权' : '已安装') : isLinux ? '未授权' : '未安装'}
                  </span>
                }
                control={
                  <>
                  <span className="kernel-helper-authorization">操作需管理员授权</span>
                  <button
                    type="button"
                    className={`btn btn-ghost${confirmUninstall ? ' danger' : ''}`}
                    title="卸载后，开启 TUN 需重新授权"
                    disabled={busy || loading.helper || !!errors.helper || !helper?.installed}
                    onClick={() => void uninstallHelper()}
                  >
                    {confirmUninstall ? (isLinux ? '确认移除' : '确认卸载') : isLinux ? '移除授权' : '卸载'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || loading.helper || !!errors.helper || !helper}
                    onClick={() => void installHelper()}
                  >
                    {helperBusy ? <Spinner small /> : null}
                    {helperBusy ? '处理中…' : isLinux ? (helper?.installed ? '重新授权' : '授权') : helper?.installed ? '重新安装' : '安装'}
                  </button>
                  </>
                }
              />
              <AnimatedDetails className="kernel-helper-location">
                <summary>{isLinux ? '内核位置' : '安装位置'}<IconChevronDown size={13} /></summary>
                <span className="kernel-file-path">{helper?.path ?? '—'}</span>
              </AnimatedDetails>
            </Section>
          <Section
            className="kernel-network"
            title="端口与访问"
            desc={running ? '修改后自动重启内核' : undefined}
          >
            <div className="kernel-port-grid">
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
              hint="内核 DNS"
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
            <OptionalPortField label="SOCKS 端口" value={settings.socksPort} defaultPort={7891} disabled={busy}
              onCommit={n => changeRuntime({ socksPort: n }, '端口已更新，内核已重启')} />
            <OptionalPortField label="HTTP 端口" value={settings.httpPort} defaultPort={7892} disabled={busy}
              onCommit={n => changeRuntime({ httpPort: n }, '端口已更新，内核已重启')} />
            <OptionalPortField label="Redir 端口" value={settings.redirPort} defaultPort={7893} disabled={busy}
              onCommit={n => changeRuntime({ redirPort: n }, '端口已更新，内核已重启')} />
            </div>
            <div className="kernel-access-grid">
            <Row
              label="监听地址"
              hint="局域网填 0.0.0.0"
              control={
                <input
                  className="input input-mono"
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
                <div className="kernel-auth-fields">
                  <input
                    className="input"
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
            </div>
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
          </div>
        </div>
      </div>
      <Dialog open={localVersionsOpen} labelledBy={localVersionsHeading} busy={busy}
        onDismiss={() => { setLocalVersionsOpen(false); setDeleteVersion(''); }}>
        <section className="kernel-local-manager">
          <div className="kernel-picker-head">
            <div><h2 id={localVersionsHeading} className="section-title">本地版本</h2><p className="field-hint">内置、已选用和运行中的内核会保留。</p></div>
            <button type="button" className="icon-btn" aria-label="关闭本地版本管理" title="关闭" disabled={busy}
              onClick={() => { setLocalVersionsOpen(false); setDeleteVersion(''); }}><IconX size={16} /></button>
          </div>
          {errors.versions && <ReadError message={errors.versions} onRetry={() => void load('versions')} busy={loading.versions || busy} />}
              <div className="kernel-version-list" role="list" aria-label="已安装内核版本">
                {versions.map(version => {
                  const selected = version.builtin ? !settings.kernelPath || settings.kernelPath === version.path : settings.kernelPath === version.path;
                  const inUse = info?.running && info.binary === version.path;
                  const protectedVersion = selected || info?.binary === version.path;
                  const confirming = deleteVersion === version.path;
                  const label = shortVersion(version.version);
                  return <div className="kernel-version-row" role="listitem" key={version.path} data-selected={selected}>
                    <div className="kernel-version-identity">
                      <span className="kernel-version-name" title={version.path}>{label}</span>
                      <span className="kernel-version-meta">{version.builtin ? '内置' : '本地'} · {(version.size / 1024 / 1024).toFixed(0)} MB{inUse ? ' · 运行中' : ''}</span>
                    </div>
                    <div className="kernel-version-actions">
                      {selected && <span className="kernel-version-selected" title="已选用" aria-label="已选用"><IconCheck size={15} /></span>}
                      {!version.builtin && <button type="button" className={`icon-btn${confirming ? ' danger' : ''}`}
                        aria-label={`${confirming ? '确认删除' : '删除'} ${label}`} title={protectedVersion ? '选用或运行中的版本不可删除' : `${confirming ? '确认删除' : '删除'} ${label}`}
                        disabled={busy || loading.versions || loading.info || !!errors.info || !!errors.versions || protectedVersion}
                        onClick={() => confirming ? void removeVersion(version) : setDeleteVersion(version.path)}><IconTrash size={15} /></button>}
                      {confirming && <button type="button" className="icon-btn" aria-label="取消删除内核" title="取消删除" disabled={busy} onClick={() => setDeleteVersion('')}><IconX size={15} /></button>}
                    </div>
                  </div>;
                })}
              </div>
        </section>
      </Dialog>
      <KernelVersionPicker open={pickerOpen} installed={versions} proxyUrl={downloadProxy()} disabled={busy}
        onClose={() => setPickerOpen(false)} onDownload={version => {
          setSpecificVersion(version); setDownloadChannel('specific'); setPickerOpen(false); void downloadLatest(version);
        }} />
    </>
  );
}
