import { emit, listen } from '@tauri-apps/api/event';
import { isTauri } from '../core/api';

import type { TextSize } from '../domain/appearance';
export type { TextSize } from '../domain/appearance';
export const TEXT_SIZES: Array<{ value: TextSize; label: string }> = [
  { value: 'standard', label: '标准' },
  { value: 'larger', label: '较大' },
  { value: 'large', label: '大' },
];
const STORAGE_KEY = 'ppclash.text-size';
const EVENT = 'appearance://text-size';
const REQUEST = 'appearance://request-text-size';
const isTextSize = (value: unknown): value is TextSize => TEXT_SIZES.some(size => size.value === value);
export const normalizeTextSize = (value: unknown): TextSize => isTextSize(value) ? value : 'standard';
function readStored(): TextSize {
  try { return normalizeTextSize(localStorage.getItem(STORAGE_KEY)); } catch { return 'standard'; }
}
let current = readStored();
let revision = 0;
export const currentTextSize = () => current;
export const textSizeRevision = () => revision;

function apply(value: TextSize) {
  current = value;
  revision++;
  document.documentElement.dataset.textSize = value;
}

/** 只修改显示偏好；磁盘持久化由 app settings 统一负责。 */
export function setTextSize(value: TextSize) {
  apply(normalizeTextSize(value));
  try { localStorage.setItem(STORAGE_KEY, current); } catch { /* 原生事件和磁盘仍可恢复。 */ }
  if (isTauri) void emit(EVENT, current).catch(() => { /* 下次打开仍从磁盘恢复。 */ });
}

/** 主窗口水合时保护刚刚发生的用户操作。 */
export function restoreTextSize(value: unknown, expectedRevision: number): TextSize {
  if (revision === expectedRevision) setTextSize(normalizeTextSize(value));
  return current;
}

/** 首帧恢复；托盘可只读一次设置，绝不调用包含代理副作用的 app.hydrate。 */
export function initTextSize(readSaved?: () => Promise<unknown>): () => void {
  document.documentElement.dataset.textSize = current;
  let alive = true;
  let dispose: (() => void) | undefined;
  let disposeRequest: (() => void) | undefined;
  const receive = (value: unknown) => { if (alive && isTextSize(value)) apply(value); };
  const storageChanged = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) receive(event.newValue);
  };
  window.addEventListener('storage', storageChanged);
  const initialRevision = revision;
  const restore = async () => {
    if (!alive || !readSaved) return;
    try {
      const value = await readSaved();
      if (alive && revision === initialRevision) apply(normalizeTextSize(value));
    } catch { /* 读取失败保留首帧偏好。 */ }
  };
  if (isTauri) {
    // 原生事件只供托盘消费；主窗口不能被自己的异步广播回声回滚。
    void listen<unknown>(EVENT, ({ payload }) => { if (readSaved) receive(payload); }).then(unlisten => {
      if (!alive) { unlisten(); return; }
      dispose = unlisten;
      // 主窗口是显示偏好的写入方。新托盘主动请求当前值，覆盖尚未落盘的旧值。
      if (readSaved) void emit(REQUEST).catch(() => {});
      return restore();
    }).catch(() => restore());
    if (!readSaved) void listen(REQUEST, () => {
      if (alive) void emit(EVENT, current).catch(() => {});
    }).then(unlisten => {
      if (!alive) unlisten(); else disposeRequest = unlisten;
    }).catch(() => {});
  } else void restore();
  return () => {
    alive = false;
    window.removeEventListener('storage', storageChanged);
    dispose?.(); dispose = undefined;
    disposeRequest?.(); disposeRequest = undefined;
  };
}
