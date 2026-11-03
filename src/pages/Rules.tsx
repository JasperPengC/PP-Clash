import { useEffect, useMemo, useState } from 'react';
import { EmptyState, MiniSwitch, Select, Spinner } from '../components/ui';
import { IconInfo, IconPlus, IconRefresh, IconRules, IconSearch, IconTrash, IconX } from '../components/icons';
import { useApp, type CustomRule } from '../store/app';
import { api } from '../core/api';

interface KernelRule {
  type: string;
  payload: string;
  proxy: string;
}

const RULE_TYPES = [
  { value: 'DOMAIN-SUFFIX', label: 'DOMAIN-SUFFIX · 域名后缀' },
  { value: 'DOMAIN-KEYWORD', label: 'DOMAIN-KEYWORD · 域名关键字' },
  { value: 'DOMAIN', label: 'DOMAIN · 完整域名' },
  { value: 'IP-CIDR', label: 'IP-CIDR · IPv4 网段' },
  { value: 'IP-CIDR6', label: 'IP-CIDR6 · IPv6 网段' },
  { value: 'GEOIP', label: 'GEOIP · 国家/地区' },
  { value: 'DST-PORT', label: 'DST-PORT · 目标端口' },
  { value: 'PROCESS-NAME', label: 'PROCESS-NAME · 进程名' },
  { value: 'NETWORK', label: 'NETWORK · 协议（tcp/udp）' },
  { value: 'MATCH', label: 'MATCH · 兜底匹配' },
];

function newId() {
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
}

export function RulesPage() {
  const connected = useApp((s) => s.kernelPhase === 'running');
  const settings = useApp((s) => s.settings);
  const groups = useApp((s) => s.groups);
  const updateSettings = useApp((s) => s.updateSettings);
  const notify = useApp((s) => s.notify);

  const rules = settings.customRules;

  const [kernelRules, setKernelRules] = useState<KernelRule[]>([]);
  const [query, setQuery] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [type, setType] = useState('DOMAIN-SUFFIX');
  const [payload, setPayload] = useState('');
  const [target, setTarget] = useState('__CURRENT__');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const [showIO, setShowIO] = useState(false);
  const [ioText, setIoText] = useState('');

  const targetOptions = useMemo(() => {
    const base = [
      { value: '__CURRENT__', label: '当前节点（自动）' },
      { value: 'DIRECT', label: 'DIRECT · 直连' },
      { value: 'REJECT', label: 'REJECT · 拒绝' },
      ...groups.map((g) => ({ value: g.name, label: g.name })),
    ];
    if (target && !base.some((o) => o.value === target)) {
      base.push({ value: target, label: target });
    }
    return base;
  }, [groups, target]);

  const loadKernelRules = async () => {
    try {
      const data: any = await api.mihomo('GET', '/rules');
      setKernelRules(data?.rules ?? []);
    } catch {
      /* 内核未运行时忽略 */
    }
  };

  useEffect(() => {
    void loadKernelRules();
  }, []);

  const resetEditor = () => {
    setEditingId(null);
    setType('DOMAIN-SUFFIX');
    setPayload('');
    setTarget('__CURRENT__');
    setEnabled(true);
  };

  const persist = async (next: CustomRule[], note: string) => {
    updateSettings({ customRules: next });
    const st = useApp.getState();
    await st.applyConfig();
    if (st.kernelPhase === 'running') {
      const ok = await st.restartKernel(true);
      if (!ok) return;
    }
    notify('success', note);
  };

  const saveRule = async () => {
    if (type !== 'MATCH' && !payload.trim()) {
      notify('error', '规则内容不能为空');
      return;
    }
    setSaving(true);
    const rule: CustomRule = {
      id: editingId ?? newId(),
      type,
      payload: type === 'MATCH' ? '' : payload.trim(),
      target,
      enabled,
    };
    const next = editingId
      ? rules.map((r) => (r.id === editingId ? rule : r))
      : [...rules, rule];
    await persist(next, editingId ? '规则已更新' : '规则已添加');
    setSaving(false);
    resetEditor();
  };

  const toggleRule = async (id: string, on: boolean) => {
    await persist(
      rules.map((r) => (r.id === id ? { ...r, enabled: on } : r)),
      on ? '规则已启用' : '规则已停用'
    );
  };

  const removeRule = async (id: string) => {
    await persist(
      rules.filter((r) => r.id !== id),
      '规则已删除'
    );
    if (editingId === id) resetEditor();
  };

  const exportRules = () => {
    const text = JSON.stringify(
      rules.map(({ id: _id, ...rest }) => rest),
      null,
      2
    );
    setIoText(text);
    setShowIO(true);
    void navigator.clipboard
      ?.writeText(text)
      .then(() => notify('success', '已复制到剪贴板'))
      .catch(() => {});
  };

  const importRules = async () => {
    try {
      const parsed = JSON.parse(ioText);
      if (!Array.isArray(parsed)) throw new Error('需要一个数组');
      const next: CustomRule[] = parsed.map((r: any, i: number) => ({
        id: newId() + i,
        type: String(r.type ?? 'DOMAIN-SUFFIX'),
        payload: String(r.payload ?? ''),
        target: String(r.target ?? 'DIRECT'),
        enabled: r.enabled !== false,
      }));
      await persist(next, `已导入 ${next.length} 条规则`);
      setShowIO(false);
      setIoText('');
    } catch (e) {
      notify('error', `导入失败：${(e as Error).message}`);
    }
  };

  const filteredKernel = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return kernelRules;
    return kernelRules.filter((r) =>
      `${r.type} ${r.payload} ${r.proxy}`.toLowerCase().includes(q)
    );
  }, [kernelRules, query]);

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">规则</h1>
          <div className="page-sub">
            {rules.length > 0 ? `${rules.length} 条自定义规则` : '自定义规则'}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={exportRules} disabled={rules.length === 0}>
            导出
          </button>
          <button type="button" className="btn" onClick={() => setShowIO((v) => !v)}>
            导入
          </button>
          <button
            type="button"
            className="icon-btn"
            title="刷新生效规则"
            aria-label="刷新生效规则"
            onClick={() => void loadKernelRules()}
          >
            <IconRefresh size={15} />
          </button>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner">
          <section className="card">
            <div className="row" style={{ gap: 10 }}>
              <span className="section-title">{editingId ? '编辑规则' : '添加规则'}</span>
              <div className="spacer" />
              <span className="card-hint">启用</span>
              <MiniSwitch on={enabled} onChange={setEnabled} label="启用规则" />
            </div>

            <div className="rule-builder">
              <Select
                value={type}
                options={RULE_TYPES}
                onChange={(v) => setType(v)}
                ariaLabel="规则类型"
                className="rule-type-select"
              />
              {type !== 'MATCH' && (
                <input
                  className="input rule-payload"
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  placeholder={
                    type === 'GEOIP' ? 'CN' : type === 'DST-PORT' ? '443' : '填写域名 / IP / 关键字'
                  }
                  aria-label="规则内容"
                  spellCheck={false}
                />
              )}
              <Select
                value={target}
                options={targetOptions}
                onChange={(v) => setTarget(v)}
                ariaLabel="规则目标"
                className="rule-target-select"
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveRule()}
                disabled={saving}
              >
                {saving ? <Spinner small /> : editingId ? null : <IconPlus size={12} />}
                {editingId ? '保存修改' : '添加'}
              </button>
              {editingId && (
                <button type="button" className="btn btn-ghost" onClick={resetEditor}>
                  取消
                </button>
              )}
            </div>
            <div className="rule-hint">
              {type === 'MATCH'
                ? 'MATCH 兜底；目标可选当前节点。'
                : 'MATCH 为兜底；目标可用当前节点。'}
            </div>
          </section>

          {showIO && (
            <section className="card">
              <div className="row" style={{ gap: 10 }}>
                <span className="section-title">导入 / 导出</span>
                <div className="spacer" />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void importRules()}
                >
                  从文本导入
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setShowIO(false)}>
                  关闭
                </button>
              </div>
              <textarea
                className="override-editor rule-io"
                value={ioText}
                onChange={(e) => setIoText(e.target.value)}
                placeholder='在这里粘贴规则 JSON，例如 [{"type":"DOMAIN-SUFFIX","payload":"example.com","target":"DIRECT","enabled":true}]'
                spellCheck={false}
              />
            </section>
          )}

          <section className="card">
            <div className="row" style={{ gap: 10 }}>
              <span className="section-title">自定义规则</span>
              <div className="spacer" />
              <span className="card-hint">{rules.length} 条</span>
            </div>
            {rules.length === 0 ? (
              <div className="rule-empty">暂无自定义规则</div>
            ) : (
              <div className="custom-rule-list">
                {rules.map((r) => (
                  <div key={r.id} className="custom-rule-row">
                    <span className="tag">{r.type}</span>
                    <span className="custom-rule-payload" title={r.payload}>
                      {r.type === 'MATCH' ? '默认兜底' : r.payload}
                    </span>
                    <span className="custom-rule-target" title={r.target}>
                      {r.target === '__CURRENT__' ? '当前节点' : r.target}
                    </span>
                    <MiniSwitch
                      on={r.enabled}
                      onChange={(v) => void toggleRule(r.id, v)}
                      label="启用规则"
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setEditingId(r.id);
                        setType(r.type);
                        setPayload(r.payload);
                        setTarget(r.target);
                        setEnabled(r.enabled);
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      title="删除规则"
                      aria-label="删除规则"
                      onClick={() => void removeRule(r.id)}
                    >
                      <IconTrash size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <div className="row" style={{ gap: 10 }}>
              <span className="section-title">当前生效规则</span>
              <div className="spacer" />
              <span className="card-hint">
                {connected ? `${kernelRules.length} 条` : '内核未运行'}
              </span>
            </div>
            {connected && kernelRules.length > 0 ? (
              <>
                <div className="row" style={{ gap: 10, marginTop: 10 }}>
                  <div className="node-search">
                    <IconSearch size={12} />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜索生效规则"
                      aria-label="搜索生效规则"
                      spellCheck={false}
                    />
                    {query && (
                      <button
                        type="button"
                        className="node-search-clear"
                        aria-label="清空搜索"
                        onClick={() => setQuery('')}
                      >
                        <IconX size={11} />
                      </button>
                    )}
                  </div>
                  <span className="card-hint">
                    显示 {filteredKernel.length} / {kernelRules.length}
                  </span>
                </div>
                <div className="kernel-rule-list">
                  <div className="rule-row rule-head">
                    <span>类型</span>
                    <span>内容</span>
                    <span>目标</span>
                  </div>
                  {filteredKernel.map((r, i) => (
                    <div key={`${i}-${r.type}-${r.payload}`} className="rule-row">
                      <span className="tag">{r.type}</span>
                      <span className="rule-payload" title={r.payload}>
                        {r.payload}
                      </span>
                      <span className="rule-proxy" title={r.proxy}>
                        {r.proxy}
                      </span>
                    </div>
                  ))}
                  {filteredKernel.length === 0 && <div className="rule-empty">没有匹配的规则</div>}
                </div>
              </>
            ) : (
              <EmptyState
                icon={<IconRules size={19} />}
                title={connected ? '暂无规则' : '内核未运行'}
                desc={connected ? '无可用规则。' : '未接管流量。'}
              />
            )}
          </section>

          <div className="banner">
            <IconInfo size={13} />
            <span>只追加规则；其它配置用覆写。</span>
          </div>
        </div>
      </div>
    </>
  );
}
