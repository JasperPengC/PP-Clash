import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ServiceProbe } from './api';
import { DiagnosticCache, DiagnosticEpoch } from './diagnostic-cache';
import { checkWebRtc, describeWebRtc } from './selfcheck';
import { checkWebRtcProtection } from './webrtc-protection';

type IpResult = Awaited<ReturnType<typeof api.leakCheckIp>> | null;
type IpQuality = Awaited<ReturnType<typeof api.checkIpQuality>>;
type ServiceMap = Record<string, ServiceProbe>;
type LeakRow = { id: string; label: string; status: 'ok' | 'warn' | 'bad' | 'info'; text: string };
interface Input {
  active: boolean; connected: boolean; routeKey: string;
  mixedPort: number; dnsPort: number; tun: boolean; githubNode: string; blockWebRtc?: boolean;
}

export function useRouteDiagnostics(input: Input) {
  const { active, connected, routeKey, mixedPort, dnsPort, tun, githubNode, blockWebRtc } = input;
  const [manualRevision, setManualRevision] = useState(0);
  const manualPending = useRef(false);
  const epochTracker = useRef(new DiagnosticEpoch());
  const epoch = epochTracker.current.update(`${manualRevision}:${routeKey}`);
  const cacheKey = `${epoch}:${routeKey}`;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && epochTracker.current.isCurrent(epoch);
  const ipCache = useRef(new DiagnosticCache<IpResult>());
  const serviceCache = useRef(new DiagnosticCache<{ map: ServiceMap; at: number }>());
  const qualityCache = useRef(new DiagnosticCache<{ quality: IpQuality | null; error: string | null; at: number }>());
  const leakCache = useRef(new DiagnosticCache<LeakRow[]>());
  const [egress, setEgress] = useState<string | null>(null);
  const [egressLoading, setEgressLoading] = useState(false);
  const [egressCountry, setEgressCountry] = useState<{ name: string | null; code: string | null } | null>(null);
  const [serviceMap, setServiceMap] = useState<ServiceMap>({});
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesAt, setServicesAt] = useState<number | null>(null);
  const [ipQuality, setIpQuality] = useState<IpQuality | null>(null);
  const [ipQualityLoading, setIpQualityLoading] = useState(false);
  const [ipQualityError, setIpQualityError] = useState<string | null>(null);
  const [ipQualityAt, setIpQualityAt] = useState<number | null>(null);
  const [leakRows, setLeakRows] = useState<LeakRow[]>([]);
  const [leakPhase, setLeakPhase] = useState<'idle' | 'running' | 'done'>('idle');

  const readIp = useCallback(async (force = false) => {
    if (!connected) return null;
    setEgressLoading(true);
    const ip = await ipCache.current.run(cacheKey, () => api.leakCheckIp(mixedPort, tun).catch(() => null), force);
    if (current()) { setEgress(ip?.proxied ?? null); setEgressLoading(false); }
    return ip;
  }, [connected, cacheKey, mixedPort, tun]);

  const runServiceProbe = useCallback(async (force = true) => {
    if (!connected) return;
    setServicesLoading(true);
    const result = await serviceCache.current.run(`${cacheKey}|${githubNode}`, async () => {
      const map: ServiceMap = {};
      await Promise.all(['google', 'youtube', 'github', 'openai', 'anthropic'].map(async id => {
        const row = await api.probeService(id, id === 'github' ? githubNode : null).catch((error): ServiceProbe => ({
          ok: false, latency_ms: null, status: 'error', detail: error instanceof Error ? error.message : String(error),
        }));
        map[id] = row;
      }));
      return { map, at: Date.now() };
    }, force);
    if (current()) { setServiceMap(result.map); setServicesAt(result.at); setServicesLoading(false); }
  }, [connected, cacheKey, githubNode]);

  const loadIpQuality = useCallback(async (force = true) => {
    if (!connected) return;
    setIpQualityLoading(true);
    const ip = await readIp(force);
    if (!current()) return;
    const result = await qualityCache.current.run(cacheKey, async () => {
      try {
        if (!ip?.proxied) throw new Error('出口 IP 暂不可用，请手动重试');
        return { quality: await api.checkIpQuality(ip.proxied), error: null, at: Date.now() };
      } catch (error) {
        return { quality: null, error: error instanceof Error ? error.message : String(error), at: Date.now() };
      }
    }, force);
    if (current()) {
      setIpQuality(result.quality); setIpQualityError(result.error); setIpQualityAt(result.at);
      setIpQualityLoading(false);
      // 质量接口已经包含国家数据，不再重复访问三个 GeoIP 服务。
      setEgressCountry(result.quality?.country ? { name: result.quality.country, code: null } : null);
    }
  }, [connected, cacheKey, readIp]);

  const runLeakCheck = useCallback(async (force = true) => {
    if (!connected) return;
    setLeakPhase('running');
    const rows = await leakCache.current.run(cacheKey, async () => {
      const [ip, dns, rtc, protection] = await Promise.all([
        readIp(force), api.leakCheckDns('www.apple.com', dnsPort).catch(() => null),
        checkWebRtc(7000, { stun: !blockWebRtc }).catch(() => null),
        blockWebRtc ? checkWebRtcProtection() : Promise.resolve({ status: 'info' as const, text: '未启用 STUN 防护' }),
      ]);
      const out: LeakRow[] = [];
      if (!ip?.proxied) out.push({ id: 'ip', label: '出口 IP', status: 'warn', text: '出口检测失败' });
      else if (tun) out.push({ id: 'ip', label: '出口 IP', status: 'ok', text: `TUN 出口 ${ip.proxied}` });
      else if (ip.direct === ip.proxied) out.push({ id: 'ip', label: '出口 IP', status: 'bad', text: '直连与代理出口相同' });
      else out.push({ id: 'ip', label: '出口 IP', status: 'ok', text: `代理出口 ${ip.proxied}` });
      out.push({ id: 'dns', label: 'DNS 接管', status: dns?.system_fake_ip ? 'ok' : dns?.kernel_alive ? 'info' : 'warn',
        text: dns?.system_fake_ip ? '已接管（Fake-IP）' : dns?.kernel_alive ? '内核可达；未确认系统接管' : 'DNS 检测失败' });
      out.push({ id: 'stun', label: 'STUN 防护', status: protection.status, text: protection.text });
      out.push({ id: 'webrtc', label: 'WebRTC 候选', ...describeWebRtc(rtc, { ...ip, tun, blockWebRtc }) });
      return out;
    }, force);
    if (current()) { setLeakRows(rows); setLeakPhase('done'); }
  }, [connected, cacheKey, readIp, dnsPort, tun, blockWebRtc]);

  useEffect(() => {
    ipCache.current.invalidate(); serviceCache.current.invalidate();
    qualityCache.current.invalidate(); leakCache.current.invalidate();
    setEgress(null); setEgressCountry(null); setServiceMap({}); setServicesAt(null);
    setIpQuality(null); setIpQualityError(null); setIpQualityAt(null);
    setEgressLoading(false); setServicesLoading(false); setIpQualityLoading(false);
    setLeakRows([]); setLeakPhase('idle');
  }, [cacheKey]);

  useEffect(() => {
    if (!active || !connected) return;
    // 同一出口切页/重新开窗只读缓存；真正变化后稳定 5 秒才探测。
    const timer = window.setTimeout(() => {
      manualPending.current = false;
      void runServiceProbe(false);
      void loadIpQuality(false);
      void runLeakCheck(false);
    }, manualPending.current ? 0 : 5000);
    return () => window.clearTimeout(timer);
  }, [active, connected, routeKey, runServiceProbe, loadIpQuality, runLeakCheck]);

  // 手动刷新统一更新这一出口的诊断快照，避免新 IP 混用旧质量/泄漏结果。
  const refresh = () => { manualPending.current = true; setManualRevision(v => v + 1); };
  return { egress, egressLoading, egressCountry, serviceMap, servicesLoading, servicesAt,
    ipQuality, ipQualityLoading, ipQualityError, ipQualityAt, leakRows, leakPhase,
    runServiceProbe: refresh, loadIpQuality: refresh, runLeakCheck: refresh };
}
