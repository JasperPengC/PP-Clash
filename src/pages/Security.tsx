import { useState } from 'react';
import { Pill, Spinner, Toggle } from '../components/ui';
import { IconAlert, IconSecurity } from '../components/icons';
import { useApp } from '../store/app';
import { api } from '../core/api';
import { checkWebRtc } from '../core/selfcheck';
import { POLICY_META, type SecurityPolicy } from '../core/security';

/** UI 上的开关语义与策略字段不一定同向，这里集中做映射。 */
const AUDIT_LABELS: Record<string, string> = {
  PLAINTEXT_DNS: 'DNS 明文地址',
  FALLBACK_SET: 'fallback 解析器',
  NO_RESPECT_RULES: 'DNS 未跟随代理规则',
  IPV6_ENABLED: 'IPv6 未隔离',
  NO_STRICT_ROUTE: 'TUN 未开启严格路由',
};

const SWITCHES: Array<{
  key: keyof SecurityPolicy;
  on: (p: SecurityPolicy) => boolean;
  apply: (v: boolean) => Partial<SecurityPolicy>;
}> = [
  {
    key: 'dnsLeakProtection',
    on: (p) => p.dnsLeakProtection,
    apply: (v) => ({ dnsLeakProtection: v }),
  },
  { key: 'fakeIp', on: (p) => p.fakeIp, apply: (v) => ({ fakeIp: v }) },
  { key: 'blockWebRtc', on: (p) => p.blockWebRtc, apply: (v) => ({ blockWebRtc: v }) },
  // 「IPv6 隔离」开 = policy.ipv6 关
  { key: 'ipv6', on: (p) => !p.ipv6, apply: (v) => ({ ipv6: !v }) },
  {
    key: 'tunStrictRoute',
    on: (p) => p.tunStrictRoute,
    apply: (v) => ({ tunStrictRoute: v }),
  },
  { key: 'blockQuic', on: (p) => p.blockQuic, apply: (v) => ({ blockQuic: v }) },
];

type RowStatus = 'ok' | 'warn' | 'bad' | 'info';
interface CheckRow {
  status: RowStatus;
  text: string;
}

const ROW_META: Record<RowStatus, { mark: string }> = {
  ok: { mark: '✓' },
  warn: { mark: '!' },
  bad: { mark: '✕' },
  info: { mark: '·' },
};

/** 泄漏自检（M3-3）：出口 IP / DNS 接管 / WebRTC，一键实测。 */
function LeakCheckCard() {
  const mixedPort = useApp((s) => s.settings.mixedPort);
  const dnsPort = useApp((s) => s.settings.dnsPort);
  const tunEnabled = useApp((s) => s.tunEnabled);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [rows, setRows] = useState<CheckRow[] | null>(null);

  const run = async () => {
    setPhase('running');
    setRows(null);
    const [ip, dns, webrtc] = await Promise.all([
      api.leakCheckIp(mixedPort, tunEnabled).catch(() => null),
      api.leakCheckDns('www.apple.com', dnsPort).catch(() => null),
      checkWebRtc(),
    ]);

    let ipRow: CheckRow;
    if (!ip) ipRow = { status: 'warn', text: '检测失败' };
    else if (!ip.proxied) ipRow = { status: 'warn', text: '代理端口不可达' };
    else if (tunEnabled)
      ipRow = { status: 'ok', text: `TUN 出口 ${ip.proxied}` };
    else if (ip.direct && ip.direct === ip.proxied)
      ipRow = { status: 'bad', text: `直连与代理出口相同（${ip.direct}）` };
    else ipRow = { status: 'ok', text: `代理出口 ${ip.proxied}` };

    let dnsRow: CheckRow;
    if (!dns) dnsRow = { status: 'warn', text: '检测失败' };
    else if (dns.system_fake_ip) dnsRow = { status: 'ok', text: '已接管（Fake-IP）' };
    else if (dns.kernel_alive && dns.kernel_fake_ip)
      dnsRow = { status: 'info', text: '内核正常；系统解析未接管' };
    else if (dns.kernel_alive)
      dnsRow = { status: 'info', text: '内核可达，未返回 Fake-IP' };
    else dnsRow = { status: 'warn', text: '内核 DNS 不可达' };

    let wr: CheckRow;
    if (!webrtc.supported) wr = { status: 'info', text: '当前环境不支持' };
    else if (webrtc.publicIps.length === 0) wr = { status: 'ok', text: '无公网候选' };
    else if (ip?.direct && webrtc.publicIps.includes(ip.direct))
      wr = { status: 'bad', text: `检测到真实 IP ${webrtc.publicIps.join('、')}` };
    else if (ip?.proxied && webrtc.publicIps.every((x) => ip.proxied!.includes(x)))
      wr = { status: 'info', text: `代理 IP ${webrtc.publicIps.join('、')}` };
    else wr = { status: 'info', text: `出口 ${webrtc.publicIps.join('、') || '无候选'}` };

    setRows([
      { status: ipRow.status, text: `出口 IP · ${ipRow.text}` },
      { status: dnsRow.status, text: `DNS 接管 · ${dnsRow.text}` },
      { status: wr.status, text: `WebRTC · ${wr.text}` },
    ]);
    setPhase('done');
  };

  const hasBad = rows?.some((r) => r.status === 'bad') ?? false;
  const hasWarn = rows?.some((r) => r.status === 'warn') ?? false;

  return (
    <section className="card">
      <div className="row" style={{ gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div className="section-title">泄漏检查</div>
          <div className="section-desc">出口 IP、DNS、WebRTC</div>
        </div>
        <div className="spacer" />
        {phase === 'done' && rows && (
          <Pill tone={hasBad ? 'bad' : hasWarn ? 'warn' : 'ok'}>
            {hasBad ? '有泄漏风险' : hasWarn ? '部分未通过' : '通过'}
          </Pill>
        )}
        <button type="button" className="btn" onClick={() => void run()} disabled={phase === 'running'}>
          {phase === 'running' ? (
            <>
              <Spinner small />
              检测中
            </>
          ) : phase === 'done' ? (
            '重新检测'
          ) : (
            '开始检测'
          )}
        </button>
      </div>

      {rows && (
        <div className="report">
          {rows.map((r) => (
            <div key={r.text} className="report-row">
              <span className={`report-mark ${r.status}`}>{ROW_META[r.status].mark}</span>
              <span>{r.text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function SecurityPage() {
  const policy = useApp((s) => s.policy);
  const setPolicy = useApp((s) => s.setPolicy);
  const audit = useApp((s) => s.audit);

  const enabled = SWITCHES.filter((s) => s.on(policy)).length;
  const total = SWITCHES.length;
  const allOn = enabled === total;

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">安全</h1>
          <div className="page-sub">默认开启</div>
        </div>
        <div className="page-actions">
          <Pill tone={allOn ? 'ok' : 'warn'}>
            {enabled}/{total} 项生效
          </Pill>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner">
          <section className="card protection-card">
            <span className={`icon-tile ${allOn ? 'success' : 'warn'}`}>
              <IconSecurity size={16} />
            </span>
            <div className="protection-main">
              <div className="protection-title">
                {allOn ? '防护完整' : '有防护被关闭'}
                <Pill tone={allOn ? 'ok' : 'warn'}>
                  {enabled}/{total}
                </Pill>
              </div>
              <div className="protection-sub">
                {allOn ? '危险配置已覆盖' : '有项目被关闭'}
              </div>
            </div>
            <div className="spacer" />
          </section>

          <div className="policy-grid">
            {SWITCHES.map((sw) => {
              const meta = POLICY_META[sw.key];
              const on = sw.on(policy);
              return (
                <div key={sw.key} className="policy-card">
                  <div className="policy-head">
                    <div className="policy-title-wrap">
                      <span className="policy-title">{meta.label}</span>
                    </div>
                    <Toggle
                      on={on}
                      onChange={(v) => setPolicy(sw.apply(v))}
                      label={meta.label}
                    />
                  </div>
                  <div className="policy-desc">{meta.desc}</div>
                  {!on && (
                    <div className="policy-risk">
                      <IconAlert size={11} />
                      <span>{meta.risk}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="settings-grid">
            <LeakCheckCard />

            <section className="card">
              <div className="row" style={{ gap: 10 }}>
                <span className="section-title">订阅配置</span>
                <div className="spacer" />
                <span className="card-hint">
                  {audit.length ? `${audit.length} 项已覆盖` : '无异常'}
                </span>
              </div>
              {audit.length > 0 ? (
                <div className="audit-list">
                  {audit.map((f) => (
                    <div key={f.code} className="audit-row">
                      <span className="audit-msg">{AUDIT_LABELS[f.code] ?? f.message}</span>
                      <span className="audit-tag">已覆盖</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="audit-empty">无</div>
              )}
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
