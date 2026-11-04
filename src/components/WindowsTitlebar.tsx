import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '../core/api';

type ResizeDirection =
  | 'East' | 'North' | 'NorthEast' | 'NorthWest'
  | 'South' | 'SouthEast' | 'SouthWest' | 'West';

/** 浏览器预览模式里没有 Tauri 运行时：返回 null，控件照常渲染但不触发窗口操作。 */
const win = () => (isTauri ? getCurrentWindow() : null);

function ResizeHandle({ dir, className }: { dir: ResizeDirection; className: string }) {
  return (
    <div
      className={`win-resize ${className}`}
      onPointerDown={(e) => {
        e.preventDefault();
        void win()?.startResizeDragging(dir).catch(() => undefined);
      }}
    />
  );
}

/**
 * Windows 的无边框窗口控件。它不占一条独立标题栏：
 * 控件浮在内容右上角，顶部留一条很窄的拖拽带，和 Clash Party 的融合式窗口一致。
 */
export function WindowsTitlebar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const w = win();
    if (!w) return;
    const sync = () => {
      void w
        .isMaximized()
        .then((max) => {
          setMaximized(max);
          document.documentElement.dataset.winMax = max ? '1' : '0';
        })
        .catch(() => undefined);
    };
    sync();
    let unlisten: (() => void) | undefined;
    void w.onResized(sync).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
      delete document.documentElement.dataset.winMax;
    };
  }, []);

  return (
    <>
      <div
        className="win-drag-strip"
        data-tauri-drag-region
        onDoubleClick={() => void win()?.toggleMaximize()}
      />
      <div className="win-window-controls">
        <button type="button" aria-label="最小化" title="最小化" onClick={() => void win()?.minimize()}>
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 5h6" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={maximized ? '还原' : '最大化'}
          title={maximized ? '还原' : '最大化'}
          onClick={() => void win()?.toggleMaximize()}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
        <button
          type="button"
          className="close"
          aria-label="关闭"
          title="关闭"
          onClick={() => void win()?.close()}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
      </div>
      <ResizeHandle dir="North" className="top" />
      <ResizeHandle dir="South" className="bottom" />
      <ResizeHandle dir="West" className="left" />
      <ResizeHandle dir="East" className="right" />
      <ResizeHandle dir="NorthWest" className="top-left" />
      <ResizeHandle dir="NorthEast" className="top-right" />
      <ResizeHandle dir="SouthWest" className="bottom-left" />
      <ResizeHandle dir="SouthEast" className="bottom-right" />
    </>
  );
}
