import { create } from 'zustand';

import type { ThemeMode } from '../domain/appearance';
export type { ThemeMode } from '../domain/appearance';

const STORAGE_KEY = 'ppclash.theme';

/** Tauri 的 tauri:// 协议下 localStorage 可能受限，任何异常都不能让应用起不来。 */
function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* 忽略 */
  }
  return 'light';
}

function writeStoredMode(m: ThemeMode) {
  try {
    localStorage.setItem(STORAGE_KEY, m);
  } catch {
    /* 忽略 */
  }
}

function resolve(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

function apply(mode: ThemeMode) {
  document.documentElement.dataset.theme = resolve(mode);
}

interface ThemeStore {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  cycle: () => void;
  label: () => string;
}

export const useTheme = create<ThemeStore>((set, get) => ({
  mode: readStoredMode(),

  setMode: (m) => {
    writeStoredMode(m);
    apply(m);
    set({ mode: m });
  },

  cycle: () => {
    const order: ThemeMode[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(get().mode) + 1) % order.length];
    get().setMode(next);
  },

  label: () =>
    ({ system: '跟随系统', light: '浅色', dark: '深色' })[get().mode],
}));

/** 应用启动时调用一次：写入初始主题，并监听系统切换。 */
export function initTheme() {
  try {
    apply(useTheme.getState().mode);
  } catch {
    // 兜底：无论如何先给一个主题，否则所有 CSS 变量为空，界面全黑
    document.documentElement.dataset.theme = 'dark';
  }

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if (useTheme.getState().mode === 'system') apply('system');
  });
}
