import { useState } from 'react';
import { siGoogle, siYoutube, siGithub, siOpenai, siAnthropic } from 'simple-icons';
import type { useRouteDiagnostics } from '../core/use-diagnostics';
import { formatTime } from '../core/format';
import { IconChevronDown, IconRefresh, IconSecurity } from './icons';
import { PageLink, Spinner } from './ui';

const services = [
  ['google', 'Google', siGoogle], ['youtube', 'YouTube', siYoutube], ['github', 'GitHub', siGithub],
  ['openai', 'ChatGPT', siOpenai], ['anthropic', 'Claude', siAnthropic],
] as const;

export function RouteDiagnosticsPanel({ connected, diagnostics, githubNode = '' }: {
  connected: boolean; diagnostics: ReturnType<typeof useRouteDiagnostics>; githubNode?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const d = diagnostics;
  const busy = d.egressLoading || d.servicesLoading || d.ipQualityLoading || d.leakPhase === 'running';
  const serviceRows = Object.values(d.serviceMap);
  const failedServices = serviceRows.filter(row => !row.ok && row.status !== 'error').length;
  const unknownServices = serviceRows.filter(row => row.status === 'error').length;
  const leakRisk = d.leakRows.some(row => row.status === 'bad');
  const leakUnknown = d.leakRows.some(row => row.status === 'warn' || row.status === 'info');
  const phase = !connected ? '连接后检测' : busy ? '检测中' : !d.servicesAt ? '等待出口稳定' : serviceRows.length < services.length || !d.ipQuality || d.leakPhase !== 'done' || d.leakRows.length === 0 ? '部分未完成' : '检测已完成';
  const serviceSummary = [failedServices ? `${failedServices} 项服务不可达` : '', unknownServices ? `${unknownServices} 项未验证` : ''].filter(Boolean).join(' · ')
    || (serviceRows.length ? `${serviceRows.filter(row => row.ok).length}/${services.length} 项可达` : '尚未检测');
  const leakSummary = d.leakPhase !== 'done' || d.leakRows.length === 0 ? '尚未完成' : leakRisk ? '有泄漏风险' : leakUnknown ? '有项目未确认' : '本次检查通过';
  const serviceStatus = failedServices ? 'bad' : unknownServices ? 'warn' : serviceRows.length === services.length ? 'ok' : 'pending';
  const qualityStatus = d.ipQualityError ? 'bad' : d.ipQuality?.risk === '高' || d.ipQuality?.risk === '中' ? 'warn' : d.ipQuality?.risk === '低' ? 'ok' : 'pending';
  const leakStatus = leakRisk ? 'bad' : leakUnknown ? 'warn' : d.leakPhase === 'done' && d.leakRows.length > 0 ? 'ok' : 'pending';
  return <section className={`ov-diagnostics diagnostics-panel${expanded ? ' is-expanded' : ''}`} aria-label="出口诊断">
    <div className="ov-diagnostic-heading diagnostics-heading">
      <div className="ov-diagnostic-title"><h2>出口诊断</h2><p title="出口稳定后检测一次，出口变化后更新，可手动刷新">{phase !== '检测已完成' ? phase : d.servicesAt ? `检测于 ${formatTime(d.servicesAt)}` : '出口稳定后检测'}</p></div>
      <div className="ov-diagnostic-summary diagnostics-summary">
        <span><span>服务连通</span><strong className={`diagnostic-status-${serviceStatus}`}>{serviceSummary}</strong></span>
        <span><span>IP 质量</span><strong className={`diagnostic-status-${qualityStatus}`}>{d.ipQualityError ? '检测失败，可重试' : d.ipQuality ? `${d.ipQuality.kind} · ${d.ipQuality.risk}风险` : '尚未完成'}</strong></span>
        <span><span>泄漏检查</span><strong className={`diagnostic-status-${leakStatus}`}>{leakSummary}</strong></span>
      </div>
      <div className="ov-diagnostic-actions">
        <button type="button" className="icon-btn" title="刷新出口诊断" aria-label="刷新出口诊断" disabled={!connected || busy} onClick={d.runServiceProbe}>
          {busy ? <Spinner small /> : <IconRefresh size={15} />}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={expanded} aria-controls="diagnostic-details" onClick={() => setExpanded(v => !v)}>
          {expanded ? '收起详情' : '查看详情'}<IconChevronDown size={13} />
        </button>
      </div>
    </div>
    {expanded && <div id="diagnostic-details" className="ov-diagnostic-details diagnostics-details" role="region" aria-label="出口诊断详情">
      <div className="ov-diagnostic-services diagnostic-section">
        <div className="ov-diagnostic-section-head"><h3>服务连通</h3><p className="ov-diagnostic-note">仅检测连接，不检查账号权限或地区限制。</p></div>
        <div className="ov-service-grid service-grid">
          {services.map(([id, name, icon]) => {
            const row = d.serviceMap[id];
            const state = row ? row.ok ? 'ok' : row.status === 'error' ? 'pending' : 'bad' : 'pending';
            return <div className={`ov-service service-tile ${state}`} key={id} title={id === 'github' && githubNode ? `测速节点：${githubNode}` : undefined}>
              <span className="service-logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={icon.path} fill="currentColor" /></svg></span>
              <div className="service-info"><span className="service-name">{name}{id === 'github' && githubNode && <span className="service-route">当前节点</span>}</span><span className={`service-latency diagnostic-status-${row ? row.ok ? 'ok' : row.status === 'error' ? 'warn' : 'bad' : 'pending'}`}>{row ? row.ok ? `${row.latency_ms ?? '—'} ms` : row.status === 'error' ? '检测异常' : '不可达' : busy ? '检测中…' : '尚未检测'}</span></div>
              {row?.detail && <p className="ov-service-detail">{row.detail}</p>}
            </div>;
          })}
        </div>
      </div>
      <div className="ov-diagnostic-quality diagnostic-section">
        <h3>IP 质量</h3>
        <p className="ov-diagnostic-note">按公开 IP 信息估算，非网站风控结果。</p>
        {d.ipQualityError && <p className="diagnostic-error" role="status">{d.ipQualityError}</p>}
        <dl className="diagnostic-facts">
          {[
            ['出口 IP', d.egress], ['类型', d.ipQuality?.kind], ['风险', d.ipQuality?.risk],
            ['参考评分', d.ipQuality && d.ipQuality.risk !== '未知' ? `${d.ipQuality.score}/100` : null], ['ASN', d.ipQuality?.asn],
            ['运营商', d.ipQuality?.isp ?? d.ipQuality?.org],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={label === '风险' || label === '参考评分' ? `diagnostic-status-${qualityStatus}` : undefined} title={value || undefined}>{value || '—'}</dd></div>)}
        </dl>
      </div>
      <div className="ov-diagnostic-leak diagnostic-section">
        <div className="ov-diagnostic-section-head"><h3>泄漏检查</h3><PageLink page="security" label="安全设置" icon={<IconSecurity size={15} />} /></div>
        <p className="ov-diagnostic-note">WebRTC 检测仅限本应用。STUN 防护按内核运行规则检查。</p>
        <div className="diagnostic-leaks">{d.leakRows.length ? d.leakRows.map(row => <div key={row.id}><span>{row.label}</span><span className={`diagnostic-status-${row.status === 'info' ? 'warn' : row.status}`}>{row.text}</span></div>) : <p className="ov-diagnostic-note">{connected ? '等待检测完成' : '连接后可检查出口 IP、DNS 与 WebRTC'}</p>}</div>
      </div>
    </div>}
  </section>;
}
