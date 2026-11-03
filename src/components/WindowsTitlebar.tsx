import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

type ResizeDirection =
  | 'East' | 'North' | 'NorthEast' | 'NorthWest'
  | 'South' | 'SouthEast' | 'SouthWest' | 'West';

const win = () => getCurrentWindow();

function ResizeHandle({ dir, className }: { dir: ResizeDirection; className: string }) {
  return (
    <div
      className={`win-resize ${className}`}
      onPointerDown={(e) => {
        e.preventDefault();
        void win().startResizeDragging(dir).catch(() => undefined);
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
    const sync = () => {
      void win().isMaximized().then(setMaximized).catch(() => undefined);
    };
    sync();
    let unlisten: (() => void) | undefined;
    void win().onResized(sync).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  return (
    <>
      <div
        className="win-drag-strip"
        data-tauri-drag-region
        onDoubleClick={() => void win().toggleMaximize()}
      />
      <div className="win-window-controls">
        <button type="button" aria-label="最小化" onClick={() => void win().minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 5h6" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => void win().toggleMaximize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
        <button
          type="button"
          className="close"
          aria-label="关闭"
          onClick={() => void win().close()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
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
