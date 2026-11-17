import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { asyncView } from './components/AsyncView';
import { initTheme } from './store/theme';
import { installLogger } from './core/logger';
import { initTextSize } from './store/text-size';
import { installOverlayScrollbars } from './core/overlay-scrollbars';
import { api, DATA_DIR, isTauri } from './core/api';
import 'flag-icons/css/flag-icons.min.css';
import './styles/index.css';

const stopOverlayScrollbars = installOverlayScrollbars();
if (import.meta.hot) import.meta.hot.dispose(stopOverlayScrollbars);

// 首帧之前定主题，避免深色系统上闪一下白屏
initTheme();
installLogger();

const params = new URLSearchParams(window.location.search);
const isTrayPanel = params.get('panel') === 'tray';
const stopTextSize = initTextSize(isTrayPanel && isTauri ? async () => {
  const raw = await api.loadAppState(DATA_DIR);
  return raw ? JSON.parse(raw).settings?.textSize : undefined;
} : undefined);
if (import.meta.hot) import.meta.hot.dispose(stopTextSize);
if (import.meta.env.DEV && ['light', 'dark'].includes(params.get('theme') ?? '')) {
  document.documentElement.dataset.theme = params.get('theme')!;
}
if (isTrayPanel) {
  document.body.classList.add('tray-panel-window');
  document.documentElement.classList.add('tray-panel-window');
}

const WindowView = isTrayPanel
  ? asyncView(() => import('./components/TrayPanel').then(module => ({ default: module.TrayPanel })))
  : asyncView(() => import('./bootstrap/main-window'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WindowView />
  </StrictMode>
);
