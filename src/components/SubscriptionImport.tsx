import { useEffect, useId, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { isTauri } from '../core/api';
import { useApp } from '../store/app';
import { normalizeSubscriptionUrl, sameSubscriptionUrl } from '../core/subscription-source';
import type { Profile } from '../domain/app';
import { Dialog } from './Dialog';
import { MiniSwitch, Segmented, Spinner } from './ui';
import { IconFolder, IconImport, IconX } from './icons';

export function SubscriptionImport({ visible, busy, profiles, running, onClose, onImportUrl, onImportFile }: {
  visible: boolean; busy: boolean; profiles: Profile[]; running: boolean; onClose: () => void;
  onImportUrl: (url: string, proxy: boolean) => Promise<boolean>; onImportFile: (path: string) => Promise<boolean>;
}) {
  const headingId = useId();
  const [source, setSource] = useState<'url' | 'file'>('url');
  const [url, setUrl] = useState('');
  const [path, setPath] = useState('');
  const [proxy, setProxy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const lock = useRef(false);
  const clearToast = useApp(s => s.clearToast);
  const input = useRef<HTMLInputElement>(null);
  const disabled = busy || pending || picking;
  useEffect(() => { if (visible && source === 'url') input.current?.focus(); }, [visible, source]);
  const choose = async () => {
    if (disabled || lock.current || !isTauri) return;
    lock.current = true; setPicking(true); setError('');
    try {
      const selected = await open({ multiple: false, directory: false,
        filters: [{ name: 'Clash / mihomo 配置', extensions: ['yaml', 'yml', 'json'] }] });
      if (typeof selected === 'string' && selected) setPath(selected);
    } catch { setError('无法选择文件，请重试'); }
    finally { lock.current = false; setPicking(false); }
  };
  const submit = async () => {
    if (disabled || lock.current) return;
    let normalized = url;
    try {
      if (source === 'url') {
        normalized = normalizeSubscriptionUrl(url);
        if (profiles.some(p => p.sourceType !== 'file' && sameSubscriptionUrl(p.url, normalized)))
          throw new Error('此订阅已添加，请使用已有订阅');
      } else {
        if (!path) throw new Error('请先选择配置文件');
        if (profiles.some(p => p.sourceType === 'file' && p.url === path)) throw new Error('此配置已添加，请使用已有订阅');
      }
    } catch (e) { setError((e as Error).message); return; }
    lock.current = true; setPending(true); setError(''); clearToast();
    try {
      const ok = source === 'url' ? await onImportUrl(normalized, proxy) : await onImportFile(path);
      if (ok) { setUrl(''); setPath(''); setProxy(false); onClose(); }
      else setError(useApp.getState().toast?.text?.replace(/^导入失败：/, '') || '导入失败，请检查来源与配置后重试');
    } catch (error) { setError(error instanceof Error ? error.message : '导入失败，请检查来源与配置后重试'); }
    finally { lock.current = false; setPending(false); }
  };
  if (!visible) return null;
  return <Dialog labelledBy={headingId} busy={disabled} onDismiss={onClose}>
  <section className="subscription-import" aria-label="添加订阅" aria-busy={pending || picking}>
    <div className="import-head">
      <h2 id={headingId} className="section-title">添加订阅</h2>
      <button type="button" className="icon-btn import-close" aria-label="取消添加订阅" title="关闭" disabled={disabled} onClick={onClose}><IconX size={16} /></button>
    </div>
      <div className="import-source-tabs">
        <Segmented ariaLabel="订阅来源" value={source} disabled={disabled}
          onChange={value => { setSource(value); setError(''); }}
          options={[{ value: 'url', label: '订阅链接' }, { value: 'file', label: '本地文件' }]} />
      </div>

    <form className="import-row" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {source === 'url' ? <>
        <label className="import-field"><span>订阅链接</span><input ref={input} className="input" inputMode="url" enterKeyHint="go" autoComplete="url" value={url} disabled={disabled} aria-label="订阅链接"
          aria-invalid={Boolean(error)} aria-describedby={error ? 'subscription-import-error' : undefined}
          placeholder="粘贴订阅链接（https://…）" spellCheck={false} autoCapitalize="off" autoCorrect="off"
          onChange={e => { setUrl(e.target.value); setError(''); }} /></label>
        <label className="import-proxy"><span>使用代理</span><MiniSwitch on={proxy} disabled={disabled}
          onChange={setProxy} label="经代理导入订阅" /></label>
      </> : <>
        <label className="import-field"><span>配置文件</span><input className="input" aria-label="待导入文件" aria-describedby={error ? 'subscription-import-error' : undefined} readOnly value={path} placeholder="选择 Clash / mihomo 配置文件" disabled={disabled} title={path} /></label>
        <button type="button" className="btn" disabled={disabled || !isTauri} onClick={() => void choose()}>
          <IconFolder size={13} />{picking ? '选择中…' : path ? '更换文件' : '选择配置文件'}</button>
      </>}
      <button type="submit" className="btn btn-primary import-submit" disabled={disabled || !(source === 'url' ? url.trim() : path)}>
        {pending ? <Spinner small /> : <IconImport size={13} />}{pending ? '导入中' : source === 'url' ? '导入' : '导入文件'}
      </button>
    </form>
    {error ? <p className="import-error" id="subscription-import-error" role="alert">{error}</p>
      : <div className="import-foot"><span className="card-hint">{source === 'file' ? '支持 YAML / JSON，最大 10 MB'
        : proxy && !running ? '内核未运行，将直连导入' : profiles.length ? '导入后保存为备用订阅' : '首次导入后自动使用'}</span></div>}
  </section>
  </Dialog>;
}
