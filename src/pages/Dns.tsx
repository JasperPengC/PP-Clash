import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ReadError, Select, Toggle } from '../components/ui';
import { useApp } from '../store/app';
import type { DnsNameserverMode } from '../domain/app';

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section className="configuration-section" aria-label={title}>
      <div className="configuration-section-head">
        <h2 className="section-title">{title}</h2>
        {desc && <p className="configuration-description">{desc}</p>}
      </div>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string;
  control: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field-row" role="group" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}>
      <div className="field-main">
        <div className="field-label" id={`${id}-label`}>{label}</div>
        {hint && <div className="field-hint" id={`${id}-hint`}>{hint}</div>}
      </div>
      <div className="field-control">{control}</div>
    </div>
  );
}

const NAMESERVERS: Array<{ value: DnsNameserverMode; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'cloudflare', label: 'Cloudflare DoH' },
  { value: 'google', label: 'Google DoH' },
  { value: 'quad9', label: 'Quad9 DoH' },
  { value: 'custom', label: '自定义' },
];

export function DnsPage() {
  const settings = useApp((s) => s.settings);
  const policy = useApp((s) => s.policy);
  const setPolicy = useApp((s) => s.setPolicy);
  const notify = useApp((s) => s.notify);

  const policyApplying = useApp(s => s.policyApplying);
  const policyError = useApp(s => s.policyError);
  const phase = useApp(s => s.kernelPhase);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const applyLock = useRef(false);
  const busy = applying || policyApplying || phase === 'starting' || phase === 'stopping';

  const [custom, setCustom] = useState(settings.dnsCustom);

  useEffect(() => {
    setCustom(settings.dnsCustom);
  }, [settings.dnsCustom]);

  const changeRuntime = async (patch: Partial<typeof settings>, note: string) => {
    if (applyLock.current || busy) return;
    applyLock.current = true;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await useApp.getState().applyRuntimeSettings(patch);
      if (result.status === 'stale') return;
      if (result.status === 'failed') {
        const message = `设置已保存但未生效：${String(result.error)}，请重试`;
        setApplyError(message);
        notify('error', message);
      } else notify('info', result.status === 'deferred' ? '设置已保存，导入订阅并连接后生效'
        : result.status === 'applied' ? note : '设置已保存，连接后生效');
    } finally {
      applyLock.current = false;
      setApplying(false);
    }
  };

  return (
    <>
      <header className="page-head page-head-wide">
        <div className="page-heading">
          <h1 className="page-title">DNS 与嗅探</h1>
          <div className="page-sub">解析与域名识别</div>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner configuration-page dns-page">
          <p className="configuration-notice" role="status">{busy ? '正在应用设置…' : phase === 'running' ? '修改设置后将重启内核，现有连接会短暂中断' : '设置将在连接后生效'}</p>
          {applyError && <ReadError message={applyError} busy={busy} onRetry={() => void changeRuntime({}, '设置已生效')} />}
          {policyError && <ReadError message={policyError} busy={busy} onRetry={() => void setPolicy({})} />}
          <div className="configuration-sheet">
          <Section title="DNS 解析" desc="选择上游服务器并设置域名解析方式">
            <Row
              label="DNS 服务器"
              hint="自定义支持 DoH / DoT"
              control={
                <Select
                  disabled={busy}
                  value={settings.dnsNameserver}
                  options={NAMESERVERS}
                  ariaLabel="DNS 服务器"
                  onChange={(v) => void changeRuntime({ dnsNameserver: v }, '已更新，内核已重启')}
                />
              }
            />
            {settings.dnsNameserver === 'custom' && (
              <Row
                label="自定义地址"
                hint="DoH / DoT 地址"
                control={
                  <input
                    className="input input-mono"
                    disabled={busy}
                    style={{ width: 260 }}
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    placeholder="https://dns.example/dns-query"
                    spellCheck={false}
                    aria-label="自定义 DNS 地址"
                    onBlur={() => {
                      const v = custom.trim();
                      if (v !== settings.dnsCustom) {
                        void changeRuntime({ dnsCustom: v }, '已更新，内核已重启');
                      }
                    }}
                  />
                }
              />
            )}
            <Row
              label="Fake-IP 模式"
              hint="连接时由代理解析域名"
              control={
                <Toggle
                  disabled={busy}
                  on={policy.fakeIp}
                  onChange={(v) => setPolicy({ fakeIp: v })}
                  label="Fake-IP 模式"
                />
              }
            />
            <Row
              label="启用 IPv6"
              hint="关闭后不使用 IPv6"
              control={
                <Toggle disabled={busy} on={policy.ipv6} onChange={(v) => setPolicy({ ipv6: v })} label="启用 IPv6" />
              }
            />
          </Section>

          <Section
            title="嗅探"
            desc="从握手提取域名"
          >
            <Row
              label="启用嗅探"
              hint="从连接中识别域名，用于匹配规则"
              control={
                <Toggle
                  disabled={busy}
                  on={settings.snifferEnabled}
                  onChange={(v) => void changeRuntime({ snifferEnabled: v }, '已更新，内核已重启')}
                  label="启用嗅探"
                />
              }
            />
            <Row
              label="覆盖目标地址"
              hint="用域名重写目标"
              control={
                <Toggle
                  disabled={busy}
                  on={settings.snifferOverrideDestination}
                  onChange={(v) =>
                    void changeRuntime({ snifferOverrideDestination: v }, '已更新，内核已重启')
                  }
                  label="覆盖目标地址"
                />
              }
            />
            <Row
              label="支持的协议"
              hint=""
              control={<span className="card-hint">HTTP · TLS · QUIC</span>}
            />
          </Section>
          </div>
        </div>
      </div>
    </>
  );
}
