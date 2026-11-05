import type { ReactNode } from 'react';
import { useApp } from '../store/app';
import { VersionBadge } from './VersionBadge';
import { BrandCat } from './BrandCat';
import {
  IconActivity,
  IconChip,
  IconCode,
  IconFolder,
  IconGlobe,
  IconLink,
  IconLog,
  IconNodes,
  IconOverview,
  IconProfiles,
  IconRules,
  IconSecurity,
  IconSettings,
} from './icons';

export type PageKey =
  | 'overview'
  | 'proxies'
  | 'connections'
  | 'profiles'
  | 'security'
  | 'rules'
  | 'logs'
  | 'override'
  | 'kernel'
  | 'resources'
  | 'traffic'
  | 'dns'
  | 'settings';

const ICONS: Record<PageKey, ReactNode> = {
  overview: <IconOverview />,
  proxies: <IconNodes />,
  connections: <IconLink />,
  security: <IconSecurity />,
  profiles: <IconProfiles />,
  rules: <IconRules />,
  logs: <IconLog />,
  override: <IconCode />,
  kernel: <IconChip />,
  resources: <IconFolder />,
  traffic: <IconActivity />,
  dns: <IconGlobe />,
  settings: <IconSettings />,
};

const LABELS: Record<PageKey, string> = {
  overview: '概览',
  proxies: '节点',
  connections: '连接',
  security: '安全',
  profiles: '订阅',
  rules: '规则',
  logs: '日志',
  override: '覆写',
  kernel: '内核',
  resources: '资源',
  traffic: '流量',
  dns: 'DNS',
  settings: '设置',
};

const BASE_ORDER: PageKey[] = ['overview', 'proxies', 'profiles', 'connections', 'security'];
const ADVANCED_ORDER: PageKey[] = ['rules', 'logs', 'override', 'kernel'];
const TOOLS_ORDER: PageKey[] = ['resources', 'traffic', 'dns'];

export function Sidebar({
  current,
  onChange,
}: {
  current: PageKey;
  onChange: (p: PageKey) => void;
}) {
  const advancedMode = useApp((s) => s.settings.advancedMode);
  const renderItem = (page: PageKey) => (
    <button
      key={page}
      type="button"
      className={`nav-item${current === page ? ' active' : ''}`}
      onClick={() => onChange(page)}
      aria-current={current === page ? 'page' : undefined}
    >
      <span className="nav-icon">{ICONS[page]}</span>
      <span className="nav-label">{LABELS[page]}</span>
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="titlebar" data-tauri-drag-region />

      <div className="sidebar-brand">
        <BrandCat size={30} className="brand-cat" />
        <span className="brand-name">PP Clash</span>
      </div>

      <div className="sidebar-label">导航</div>
      <nav className="sidebar-nav" aria-label="主导航">
        {BASE_ORDER.map((page) => renderItem(page))}
      </nav>

      {advancedMode && (
        <>
          <div className="sidebar-label">高级</div>
          <nav className="sidebar-nav" aria-label="高级功能">
            {ADVANCED_ORDER.map((page) => renderItem(page))}
          </nav>
          <div className="sidebar-label">工具</div>
          <nav className="sidebar-nav" aria-label="工具">
            {TOOLS_ORDER.map((page) => renderItem(page))}
          </nav>
        </>
      )}

      <nav className="sidebar-nav" aria-label="设置">
        {renderItem('settings')}
      </nav>
      <div className="sidebar-version">
        <VersionBadge />
      </div>
    </aside>
  );
}
