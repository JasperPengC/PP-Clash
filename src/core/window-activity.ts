import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './api';

/** 失焦仍可见的窗口继续刷新；仅隐藏/最小化暂停展示工作。 */
export function useWindowVisible(): boolean {
  const [nativeVisible, setNativeVisible] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(!document.hidden);
  useEffect(() => {
    let alive = true;
    let revision = 0;
    let dispose: (() => void) | undefined;
    const changed = () => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    if (isTauri) void listen<boolean>('window://visible', ({ payload }) => {
      revision++;
      if (alive) setNativeVisible(payload);
    }).then(async unlisten => {
      if (!alive) { unlisten(); return; }
      dispose = unlisten;
      const initialRevision = revision;
      const visible = await invoke<boolean>('main_window_visible').catch(() => true);
      if (alive && revision === initialRevision) setNativeVisible(visible);
    }).catch(() => { /* 文档可见性仍可工作；避免监听失败成为未处理异常。 */ });
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', changed);
      dispose?.();
    };
  }, []);
  return nativeVisible && documentVisible;
}
