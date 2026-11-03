import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Segmented, Select, Toggle } from '../components/ui';
import { IconDownload, IconFolder, IconPalette, IconSliders } from '../components/icons';
import { formatTime } from '../core/format';
import { useApp, type ThemeMode } from '../store/app';
import { api, DATA_DIR, isTauri } from '../core/api';

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

const GH_PRESETS = [
  { value: 'auto', label: '自动（优先代理）' },
  { value: '', label: '直连' },
  { value: 'https://gh-proxy.org/', label: 'gh-proxy.org' },
  { value: 'https://ghfast.top/', label: 'ghfast.top' },
  { value: 'https://down.clashparty.org/', label: 'down.clashparty.org' },
  { value: 'https://download.mihomo.party/', label: 'download.mihomo.party' },
];

const THEMES: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

/** 数字端口：回车 / 失焦才提交，避免边打字边重启内核。 */
export function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const checkingUpdate = useApp((s) => s.checkingUpdate);
  const checkUpdate = useApp((s) => s.checkUpdate);
  const updateInfo = useApp((s) => s.updateInfo);

  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);
  const [backups, setBackups] = useState<
    Array<{ name: string; size: number; mtimeMs: number }>
  >([]);

  const [proxyCustomOpen, setProxyCustomOpen] = useState(false);
  const [ghDraft, setGhDraft] = useState(settings.githubProxy);
  const [feedDraft, setFeedDraft] = useState(settings.updateFeedUrl);

  useEffect(() => {
    setGhDraft(settings.githubProxy);
  }, [settings.githubProxy]);

  useEffect(() => {
    setFeedDraft(settings.updateFeedUrl);
  }, [settings.updateFeedUrl]);

  const isCustomProxy =
    settings.githubProxy !== '' &&
    settings.githubProxy !== 'auto' &&
    !GH_PRESETS.some((p) => p.value === settings.githubProxy);
  const proxySelectValue = isCustomProxy ? '__custom__' : settings.githubProxy;
  const proxyOptions = [
    ...GH_PRESETS,
    { value: '__custom__', label: isCustomProxy ? '自定义' : '自定义…' },
  ];

  const loadBackups = async () => {
    if (!isTauri) return;
    try {
      setBackups(await api.listBackups(DATA_DIR));
    } catch {
      /* 忽略 */
    }
  };

  useEffect(() => {
    void loadBackups();
  }, []);

  const doBackup = async () => {
    const notify = useApp.getState().notify;
    try {
      const path = await api.backupAppState(DATA_DIR);
      notify('success', `已备份到 ${path.split(/[\\/]/).pop()}`);
      await loadBackups();
    } catch (e) {
      notify('error', `备份失败：${String(e)}`);
    }
  };

  const doRestore = async (name: string) => {
    const notify = useApp.getState().notify;
    if (restoreConfirm !== name) {
      setRestoreConfirm(name);
      window.setTimeout(() => setRestoreConfirm((cur) => (cur === name ? null : cur)), 3000);
      return;
    }
    setRestoreConfirm(null);
    try {
      await api.restoreBackup(DATA_DIR, name);
      notify('success', '已恢复，正在重新加载');
      window.setTimeout(() => location.reload(), 900);
    } catch (e) {
      notify('error', `恢复失败：${String(e)}`);
    }
  };

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">设置</h1>
          <div className="page-sub">通用、下载、备份、进阶</div>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner">
          <div className="settings-page">
            <Section title="通用" desc="主题、启动与关窗行为" icon={<IconPalette size={15} />}>
              <Row
                label="主题"
                hint="跟随系统"
                control={
                  <Segmented
                    options={THEMES}
                    value={settings.theme}
                    onChange={(v) => updateSettings({ theme: v })}
                  />
                }
              />
              <Row
                label="托盘实时网速"
                hint="显示上传 / 下载"
                control={
                  <Toggle
                    on={settings.traySpeed}
                    onChange={(v) => updateSettings({ traySpeed: v })}
                    label="托盘实时网速"
                  />
                }
              />
              <Row
                label="开机自启"
                hint="登录后启动"
                control={
                  <Toggle
                    on={settings.launchAtLogin}
                    onChange={(v) => updateSettings({ launchAtLogin: v })}
                    label="开机自启"
                  />
                }
              />
              <Row
                label="关闭窗口后隐藏 Dock 图标"
                hint={settings.closeToTray ? '菜单栏保持常驻' : '先开启关窗到托盘'}
                control={
                  <Toggle
                    on={settings.hideDockOnClose}
                    disabled={!settings.closeToTray}
                    onChange={(v) => updateSettings({ hideDockOnClose: v })}
                    label="关闭窗口后隐藏 Dock 图标"
                  />
                }
              />
              <Row
                label="关窗最小化到托盘"
                hint="关闭则退出；托盘仍可操作"
                control={
                  <Toggle
                    on={settings.closeToTray}
                    onChange={(v) => updateSettings({ closeToTray: v })}
                    label="关窗最小化到托盘"
                  />
                }
              />
            </Section>

            <Section
              title="下载"
              desc="下载内核 / 资源时使用的 GitHub 代理"
              icon={<IconDownload size={15} />}
            >
              <Row
                label="GitHub 下载代理"
                hint="自动优先本机代理"
                control={
                  <Select
                    value={proxySelectValue}
                    options={proxyOptions}
                    ariaLabel="GitHub 下载代理"
                    onChange={(v) => {
                      if (v === '__custom__') {
                        setProxyCustomOpen(true);
                        return;
                      }
                      setProxyCustomOpen(false);
                      updateSettings({ githubProxy: v });
                    }}
                  />
                }
              />
              {(isCustomProxy || proxyCustomOpen) && (
                <Row
                  label="自定义前缀"
                  hint="下载链接前缀"
                  control={
                    <input
                      className="input"
                      style={{ width: 240 }}
                      value={ghDraft}
                      onChange={(e) => setGhDraft(e.target.value)}
                      placeholder="https://your-proxy.example/"
                      spellCheck={false}
                      aria-label="自定义 GitHub 下载代理"
                      onBlur={() => {
                        const v = ghDraft.trim();
                        if (v !== settings.githubProxy) updateSettings({ githubProxy: v });
                      }}
                    />
                  }
                />
              )}
            </Section>

            <Section title="备份与恢复" desc="保存/恢复订阅与设置" icon={<IconFolder size={15} />}>
              <Row
                label="立即备份"
                hint="保存到 backups/"
                control={
                  <button type="button" className="btn" onClick={() => void doBackup()}>
                    备份
                  </button>
                }
              />
              {backups.slice(0, 3).map((b) => (
                <Row
                  key={b.name}
                  label={formatTime(b.mtimeMs)}
                  hint={`${(b.size / 1024).toFixed(1)} KB`}
                  control={
                    <button
                      type="button"
                      className={`btn btn-sm${restoreConfirm === b.name ? ' btn-danger' : ''}`}
                      onClick={() => void doRestore(b.name)}
                    >
                      {restoreConfirm === b.name ? '确认恢复' : '恢复'}
                    </button>
                  }
                />
              ))}
              {backups.length === 0 && (
                <Row label="暂无备份" control={null} />
              )}
            </Section>

            <Section
              title="应用更新"
              desc="只检查并提示，不自动下载"
              icon={<IconDownload size={15} />}
            >
              <Row
                label="更新源"
                hint="返回 { version, url, notes } 的 JSON；留空关闭"
                control={
                  <input
                    className="input input-mono"
                    style={{ width: 220 }}
                    value={feedDraft}
                    onChange={(e) => setFeedDraft(e.target.value)}
                    onBlur={() => {
                      const v = feedDraft.trim();
                      if (v !== settings.updateFeedUrl) updateSettings({ updateFeedUrl: v });
                    }}
                    placeholder="https://example.com/ppclash.json"
                    spellCheck={false}
                    aria-label="应用更新源"
                  />
                }
              />
              <Row
                label="启动时检查"
                hint="只在配置了更新源时生效"
                control={
                  <Toggle
                    on={settings.updateCheckOnLaunch}
                    onChange={(v) => updateSettings({ updateCheckOnLaunch: v })}
                    label="启动时检查更新"
                  />
                }
              />
              <Row
                label="检查更新"
                hint={
                  updateInfo
                    ? `发现新版本 ${updateInfo.version}`
                    : settings.updateFeedUrl.trim()
                      ? '手动检查一次'
                      : '先填写更新源'
                }
                control={
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={checkingUpdate || !settings.updateFeedUrl.trim()}
                    onClick={() => void checkUpdate(false)}
                  >
                    {checkingUpdate ? '检查中…' : '检查'}
                  </button>
                }
              />
            </Section>

            <Section title="进阶" desc="默认隐藏" icon={<IconSliders size={15} />}>
              <Row
                label="显示进阶功能"
                hint="显示高级页面"
                control={
                  <Toggle
                    on={settings.advancedMode}
                    onChange={(v) => updateSettings({ advancedMode: v })}
                    label="显示进阶功能"
                  />
                }
              />
              <Row
                label="订阅自动更新"
                hint="各订阅单独设置"
                control={
                  <Toggle
                    on={settings.autoUpdate}
                    onChange={(v) => updateSettings({ autoUpdate: v })}
                    label="订阅自动更新"
                  />
                }
              />
            </Section>
          </div>

          <div className="settings-about">
            PP Clash 0.1.0 · 构建 {__BUILD_TIME__.slice(0, 16).replace('T', ' ')}
          </div>
        </div>
      </div>
    </>
  );
}
