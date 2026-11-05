import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { TrayPanel } from './components/TrayPanel';
import { initTheme } from './store/theme';
import { installLogger } from './core/logger';
import { useApp } from './store/app';
import 'flag-icons/css/flag-icons.min.css';
import './styles/theme.css';

// 首帧之前定主题，避免深色系统上闪一下白屏
initTheme();
installLogger();

const params = new URLSearchParams(window.location.search);
const isTrayPanel = params.get('panel') === 'tray';
if (import.meta.env.DEV && params.get('theme') === 'light') {
  document.documentElement.dataset.theme = 'light';
}
if (isTrayPanel) document.body.classList.add('tray-panel-window');

// 水合：从磁盘恢复订阅 / 策略 / 设置。必须在渲染前尽量早执行
if (!isTrayPanel) void useApp.getState().hydrate();

// 仅开发环境：访问 /?preview=connected 时注入「已连接」演示数据，用于检查 UI
if (import.meta.env.DEV && !isTrayPanel) {
  void import('./dev/preview').then((m) => m.applyPreviewIfRequested());
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isTrayPanel ? <TrayPanel /> : <App />}
  </StrictMode>
);
