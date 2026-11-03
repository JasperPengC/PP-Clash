import { useEffect, useMemo, useState } from 'react';
import yaml from 'js-yaml';
import { EmptyState, MiniSwitch, Segmented, Spinner, Toggle } from '../components/ui';
import { IconCode, IconPlus, IconTrash } from '../components/icons';
import { useApp, type OverrideFile } from '../store/app';

const PLACEHOLDER_YAML = `# YAML / JSON 片段，深合并到生成的配置
# 对象按 key 合并，数组整体替换
#
# rules:
#   - DOMAIN-SUFFIX,example.com,DIRECT
# dns:
#   nameserver:
#     - https://dns.google/dns-query
`;

const PLACEHOLDER_JS = `// 直接修改 config 并返回；脚本以应用权限执行
config.mode = "global";
config["log-level"] = "debug";
return config;
`;

function newOverride(index: number): OverrideFile {
  return {
    id: `override-${Date.now()}-${index}`,
    name: `覆写 ${index}`,
    mode: 'yaml',
    enabled: true,
    text: '',
  };
}

export function OverridePage() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const notify = useApp((s) => s.notify);

  const files = settings.overrides;
  const [selectedId, setSelectedId] = useState<string | undefined>(files[0]?.id);
  const selected = useMemo(
    () => files.find((f) => f.id === selectedId) ?? files[0],
    [files, selectedId]
  );

  const [name, setName] = useState('');
  const [mode, setMode] = useState<'yaml' | 'js'>('yaml');
  const [text, setText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setMode(selected.mode);
    setText(selected.text);
    setEnabled(selected.enabled);
    setError(null);
    setConfirmDelete(false);
  }, [selected?.id]);

  useEffect(() => {
    if (files.length > 0 && !files.some((f) => f.id === selectedId)) {
      setSelectedId(files[0].id);
    }
    if (files.length === 0 && selectedId) setSelectedId(undefined);
  }, [files, selectedId]);

  const add = () => {
    const file = newOverride(files.length + 1);
    updateSettings({ overrides: [...files, file] });
    setSelectedId(file.id);
  };

  const apply = async (nextFiles: OverrideFile[], note: string) => {
    updateSettings({ overrides: nextFiles });
    const st = useApp.getState();
    await st.applyConfig();
    if (st.kernelPhase === 'running') {
      const ok = await st.restartKernel(true);
      if (!ok) return;
    }
    notify('success', note);
  };

  const save = async () => {
    if (!selected) return;
    const finalName = name.trim() || selected.name;

    if (text.trim() && mode === 'yaml') {
      try {
        const parsed = yaml.load(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('顶层需要是一个对象（键值对）');
        }
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }

    setError(null);
    setSaving(true);
    const next = files.map((f) =>
      f.id === selected.id ? { ...f, name: finalName, mode, enabled, text } : f
    );
    await apply(next, `已保存「${finalName}」`);
    setSaving(false);
  };

  const remove = async () => {
    if (!selected) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      window.setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    setConfirmDelete(false);
    const next = files.filter((f) => f.id !== selected.id);
    setSelectedId(next[0]?.id);
    await apply(next, '覆写已删除');
  };

  const move = async (dir: -1 | 1) => {
    if (!selected) return;
    const index = files.findIndex((f) => f.id === selected.id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= files.length) return;
    const next = [...files];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    await apply(next, '覆写顺序已更新');
  };

  const canMoveUp = selected ? files.findIndex((f) => f.id === selected.id) > 0 : false;
  const canMoveDown = selected
    ? files.findIndex((f) => f.id === selected.id) < files.length - 1
    : false;

  const toggleFile = async (file: OverrideFile, on: boolean) => {
    await apply(
      files.map((f) => (f.id === file.id ? { ...f, enabled: on } : f)),
      on ? '覆写已启用' : '覆写已停用'
    );
  };

  const enabledCount = files.filter((f) => f.enabled).length;

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">覆写</h1>
          <div className="page-sub">
            {files.length > 0
              ? `${files.length} 个文件 · ${enabledCount} 个启用，按列表顺序合并`
              : '多文件按顺序合并到生成配置'}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={add}>
            <IconPlus size={13} />
            新建覆写
          </button>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner">
          {files.length === 0 ? (
            <section className="card">
              <EmptyState
                icon={<IconCode size={19} />}
                title="还没有覆写"
                desc="覆盖生成的配置；规则只管路由。"
                action={
                  <button type="button" className="btn btn-primary" onClick={add}>
                    新建覆写
                  </button>
                }
              />
            </section>
          ) : (
            <div className="override-layout">
              <section className="card card-flush override-files">
                <div className="override-files-head">
                  <span>覆写文件</span>
                  <span>{files.length}</span>
                </div>
                {files.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`override-file${f.id === selected?.id ? ' active' : ''}`}
                    onClick={() => setSelectedId(f.id)}
                  >
                    <span className={`override-dot${f.enabled ? ' on' : ''}`} />
                    <span className="override-file-name">{f.name}</span>
                    <span className="override-mode">{f.mode === 'js' ? 'JS' : 'YAML'}</span>
                    <MiniSwitch
                      on={f.enabled}
                      onChange={(v) => void toggleFile(f, v)}
                      label={f.enabled ? '停用覆写' : '启用覆写'}
                    />
                  </button>
                ))}
                <button type="button" className="override-file-add" onClick={add}>
                  <IconPlus size={12} />
                  新建覆写
                </button>
              </section>

              <section className="card override-editor-card">
                <div className="override-toolbar">
                  <input
                    className="input override-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-label="覆写名称"
                    spellCheck={false}
                  />
                  <Segmented
                    ariaLabel="覆写类型"
                    options={[
                      { value: 'yaml', label: 'YAML' },
                      { value: 'js', label: 'JS' },
                    ]}
                    value={mode}
                    onChange={(v) => setMode(v)}
                  />
                  <div className="row" style={{ gap: 7 }}>
                    <span className="card-hint">启用</span>
                    <Toggle on={enabled} onChange={setEnabled} label="启用覆写" />
                  </div>
                  <div className="spacer" />
                  <button
                    type="button"
                    className="icon-btn"
                    title="上移（更早合并）"
                    aria-label="上移"
                    disabled={!canMoveUp}
                    onClick={() => void move(-1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="下移（更晚合并）"
                    aria-label="下移"
                    disabled={!canMoveDown}
                    onClick={() => void move(1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={`icon-btn danger${confirmDelete ? ' confirming' : ''}`}
                    title={confirmDelete ? '再点一次删除' : '删除覆写'}
                    aria-label={confirmDelete ? '确认删除' : '删除覆写'}
                    onClick={() => void remove()}
                  >
                    {confirmDelete ? <span className="t-micro">确认删除</span> : <IconTrash size={14} />}
                  </button>
                </div>

                <div style={{ padding: '12px 16px' }}>
                  <textarea
                    className="override-editor"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={mode === 'yaml' ? PLACEHOLDER_YAML : PLACEHOLDER_JS}
                    spellCheck={false}
                  />
                  {mode === 'js' && (
                    <div className="override-error" style={{ color: 'var(--warning)' }}>
                      JS 脚本在隔离 Worker 中执行，有 300ms 超时限制。
                    </div>
                  )}
                  {error && <div className="override-error">解析失败：{error}</div>}
                </div>

                <div className="override-foot">
                  <span className="card-hint">
                    {'{{CURRENT_NODE}}'} 为当前节点；按列表顺序覆盖。
                  </span>
                  <div className="spacer" />
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void save()}
                    disabled={saving}
                  >
                    {saving ? <Spinner small /> : null}
                    保存并应用
                  </button>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
