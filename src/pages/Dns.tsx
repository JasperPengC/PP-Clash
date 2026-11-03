import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Select, Toggle } from '../components/ui';
import { IconGlobe, IconSliders } from '../components/icons';
import { useApp, type DnsNameserverMode } from '../store/app';

function Section({
  title,
  desc,
  icon,
  children,
}: {
  title: string;
  desc?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="section-head">
        {icon && <span className="icon-tile">{icon}</span>}
        <div className="section-head-text">
          <div className="section-title">{title}</div>
          {desc && <div className="section-desc">{desc}</div>}
        </div>
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
  return (
    <div className="field-row">
      <div className="field-main">
        <div className="field-label">{label}</div>
        {hint && <div className="field-hint">{hint}</div>}
      </div>
      <div className="field-control">{control}</div>
    </div>
  );
}

const NAMESERVERS: Array<{ value: DnsNameserverMode; label: string }> = [
  { value: 'auto', label: '自动（安全默认）' },
  { value: 'cloudflare', label: 'Cloudflare DoH' },
  { value: 'google', label: 'Google DoH' },
  { value: 'quad9', label: 'Quad9 DoH' },
  { value: 'custom', label: '自定义' },
];

export function DnsPage() {
  const settings = useApp((s) => s.settings);
  const policy = useApp((s) => s.policy);
  const updateSettings = useApp((s) => s.updateSettings);
  const setPolicy = useApp((s) => s.setPolicy);
  const notify = useApp((s) => s.notify);

  const [custom, setCustom] = useState(settings.dnsCustom);

  useEffect(() => {
    setCustom(settings.dnsCustom);
  }, [settings.dnsCustom]);

  const changeRuntime = async (patch: Partial<typeof settings>, note: string) => {
    updateSettings(patch);
    const st = useApp.getState();
    await st.applyConfig();
    if (st.kernelPhase === 'running') {
      const ok = await st.restartKernel(true);
      if (ok) notify('info', note);
    }
  };

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">DNS 与嗅探</h1>
          <div className="page-sub">DNS 服务器、Fake-IP、IPv6 与域名嗅探</div>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner kernel-page">
          <Section title="DNS" desc="加密 DNS" icon={<IconGlobe size={15} />}>
            <Row
              label="DNS 服务器"
              hint="自定义支持 DoH / DoT"
              control={
                <Select
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
              hint="延迟到代理解析"
              control={
                <Toggle
                  on={policy.fakeIp}
                  onChange={(v) => setPolicy({ fakeIp: v })}
                  label="Fake-IP 模式"
                />
              }
            />
            <Row
              label="启用 IPv6"
              hint="关闭以避免绕过 TUN"
              control={
                <Toggle on={policy.ipv6} onChange={(v) => setPolicy({ ipv6: v })} label="启用 IPv6" />
              }
            />
          </Section>

          <Section
            title="嗅探"
            desc="从握手提取域名"
            icon={<IconSliders size={15} />}
          >
            <Row
              label="启用嗅探"
              hint="按域名匹配规则"
              control={
                <Toggle
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
    </>
  );
}
