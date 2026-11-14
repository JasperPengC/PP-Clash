import { useEffect, useRef, useState } from 'react';
import { ReadError, Spinner, Toggle } from '../components/ui';
import { IconAlert, IconCheck, IconInfo, IconX } from '../components/icons';
import { useApp } from '../store/app';
import { api } from '../core/api';
import { checkWebRtc, describeWebRtc } from '../core/selfcheck';
import { checkWebRtcProtection } from '../core/webrtc-protection';
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

const ROW_META = {
  ok: { mark: <IconCheck size={12} /> },
  warn: { mark: <IconAlert size={12} /> },
  bad: { mark: <IconX size={12} /> },
  info: { mark: <IconInfo size={12} /> },
};

/** 泄漏自检（M3-3）：出口 IP / DNS 接管 / WebRTC，一键实测。 */
function LeakCheckCard() {
  const connected = useApp(s => s.kernelPhase === 'running');
  const revision = useApp(s => s.routeRevision);
  const policy = useApp(s => s.policy);
  const checkEpoch = useRef(0);
  const running = useRef(false);
  const mixedPort = useApp((s) => s.settings.mixedPort);
  const dnsPort = useApp((s) => s.settings.dnsPort);
  const tunEnabled = useApp((s) => s.tunEnabled);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [rows, setRows] = useState<CheckRow[] | null>(null);

  useEffect(() => {
    checkEpoch.current += 1; running.current = false; setRows(null); setPhase('idle');
    return () => { checkEpoch.current += 1; };
  }, [revision, policy, mixedPort, dnsPort, tunEnabled, connected]);

  const run = async () => {
    if (running.current || !connected) return;
    const epoch = ++checkEpoch.current;
    running.current = true;
    setPhase('running');
    setRows(null);
    const [ip, dns, webrtc, protection] = await Promise.all([
      api.leakCheckIp(mixedPort, tunEnabled).catch(() => null),
      api.leakCheckDns('www.apple.com', dnsPort).catch(() => null),
      checkWebRtc(7000, { stun: !policy.blockWebRtc }).catch(() => null),
      policy.blockWebRtc ? checkWebRtcProtection() : Promise.resolve({ status: 'info' as const, text: '未启用 STUN 防护' }),
    ]);

    if (epoch !== checkEpoch.current) return;
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

    const wr: CheckRow = describeWebRtc(webrtc, { ...ip, tun: tunEnabled, blockWebRtc: policy.blockWebRtc });

    setRows([
      { status: ipRow.status, text: `出口 IP · ${ipRow.text}` },
      { status: dnsRow.status, text: `DNS 接管 · ${dnsRow.text}` },
      { status: protection.status, text: `STUN 防护 · ${protection.text}` },
      { status: wr.status, text: `WebRTC 候选 · ${wr.text}` },
    ]);
    setPhase('done');
    running.current = false;
  };

  const hasBad = rows?.some((r) => r.status === 'bad') ?? false;
  const hasWarn = rows?.some((r) => r.status === 'warn' || r.status === 'info') ?? false;

  return (
    <section className="configuration-check" aria-label="泄漏检查">
      <div className="configuration-check-head">
        <div className="configuration-check-title">
          <h2 className="section-title">泄漏检查</h2>
          <p className="configuration-description">{connected ? '出口 IP、DNS、WebRTC' : '连接后可检测出口 IP、DNS、WebRTC'}</p>
        </div>
        {phase === 'done' && rows && (
          <span className={`configuration-state ${hasBad ? 'bad' : hasWarn ? 'warn' : 'ok'}`} role="status">
            {hasBad ? '有泄漏风险' : hasWarn ? '部分未验证' : '通过'}
          </span>
        )}
        <button type="button" className="btn" onClick={() => void run()} disabled={!connected || phase === 'running'}>
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
          <p className="card-hint">WebRTC 检测仅限本应用。STUN 防护按内核运行规则检查。</p>
          {rows.map((r) => (
            <div key={r.text} className="report-row">
              <span className={`report-mark ${r.status}`} aria-hidden="true">{ROW_META[r.status].mark}</span>
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
  const policyApplying = useApp(s => s.policyApplying);
  const policyError = useApp(s => s.policyError);
  const phase = useApp(s => s.kernelPhase);
  const busy = policyApplying || phase === 'starting' || phase === 'stopping';
  const audit = useApp((s) => s.audit);
  const conflicts = audit.filter(finding => finding.code.startsWith('FINAL_'));
  const hasConflict = conflicts.length > 0;

  const enabled = SWITCHES.filter((s) => s.on(policy)).length;
  const total = SWITCHES.length;
  const allOn = enabled === total;

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">安全</h1>
          <div className="page-sub">网络防护与泄漏检测</div>
        </div>
        <div className="page-actions">
          <span className="configuration-page-count">
            {enabled}/{total} 项已启用{busy ? ' · 应用中' : policyError ? ' · 未生效' : phase !== 'running' ? ' · 连接后生效' : ''}
          </span>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner configuration-page security-page">
          {policyError && <ReadError message={policyError} busy={busy} onRetry={() => void setPolicy({})} />}
          <section className="configuration-sheet security-policies" aria-label="网络防护策略">
            <div className="configuration-section-head security-policy-head">
              <div>
                <h2 className="section-title">网络防护</h2>
                <p className={`configuration-description${hasConflict || policyError ? ' configuration-warning' : ''}`} role="status">
                {busy ? '正在应用策略…' : policyError ? '修改未生效，请重试' : hasConflict ? '最终配置与防护设置不一致，请检查覆写' : phase !== 'running' ? '策略已保存，连接后生效' : '配置已应用；实际接管见下方检测'}
                </p>
              </div>
              <span className={`configuration-state ${allOn && !hasConflict && !policyError ? 'ok' : 'warn'}`}>{allOn ? '全部策略已开启' : `${enabled}/${total} 项已开启`}</span>
            </div>
          <div className="security-policy-list">
            {SWITCHES.map((sw) => {
              const meta = POLICY_META[sw.key];
              const on = sw.on(policy);
              return (
                <div key={sw.key} className="field-row security-policy-row" role="group" aria-labelledby={`security-${sw.key}-label`} aria-describedby={`security-${sw.key}-hint`}>
                  <div className="field-main">
                    <div className="field-label" id={`security-${sw.key}-label`}>{meta.label}</div>
                    <div className="field-hint" id={`security-${sw.key}-hint`}>{meta.desc}</div>
                    {!on && (
                      <div className="security-policy-risk">
                        <IconAlert size={12} />
                        <span>{meta.risk}</span>
                      </div>
                    )}
                  </div>
                  <div className="field-control">
                    <Toggle
                      disabled={busy}
                      on={on}
                      onChange={(v) => setPolicy(sw.apply(v))}
                      label={meta.label}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          </section>

          <div className="security-checks">
            <LeakCheckCard />

            <section className="configuration-check" aria-label="配置检查">
              <div className="configuration-check-head">
                <div className="configuration-check-title">
                  <h2 className="section-title">配置检查</h2>
                  <p className="configuration-description">订阅原配置与最终生效配置</p>
                </div>
                <span className={`configuration-state${hasConflict ? ' warn' : ''}`}>
                  {hasConflict ? `${conflicts.length} 项不一致` : '未发现配置冲突'}
                </span>
              </div>
              {audit.length > 0 ? (
                <div className="audit-list">
                  {audit.map((f) => (
                    <div key={f.code} className="audit-row">
                      <span className="audit-msg">{AUDIT_LABELS[f.code] ?? f.message}</span>
                      <span className={`audit-tag${f.code.startsWith('FINAL_') ? ' configuration-warning' : ''}`}>
                        {f.code.startsWith('FINAL_') ? '不一致' : '订阅原配置'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="audit-empty">没有发现需要检查的配置项</div>
              )}
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
