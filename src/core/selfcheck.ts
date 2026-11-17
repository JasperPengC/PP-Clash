/**
 * WebRTC 泄漏自检（前端侧，M3-3 的一部分）。
 *
 * 防护开启时只收集本地候选，STUN 规则另行通过运行内核核验。
 * 防护关闭时使用 STUN 收集 srflx 候选。
 * 结果交给 UI 与直连 / 代理出口 IP 对比后定性。
 * WKWebView 不一定有 RTCPeerConnection，不支持时诚实返回 supported: false。
 */

export interface WebRtcResult {
  scope?: 'host' | 'stun';
  supported: boolean;
  status: 'complete' | 'unsupported' | 'error' | 'timeout';
  publicIps: string[];
  stunError?: number;
  detail?: string;
}

/** 只取候选本身的地址，不能把 raddr（本地关联地址）当成公网出口。 */
function publicAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const ip = address.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const [a, b, ...tail] = ip.split('.').map(Number);
    if ([a, b, ...tail].some(n => n > 255) || a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))) return null;
    return ip;
  }
  // IPv6 全局单播；不把链路本地、ULA、mDNS host 和未指定地址当公网。
  if (!/^[23][0-9a-f]{3}:/.test(ip)) return null;
  try { return new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return null; }
}

export function describeWebRtc(result: WebRtcResult | null, context: {
  direct?: string | null; proxied?: string | null; tun: boolean; blockWebRtc?: boolean;
}): { status: 'ok' | 'warn' | 'bad' | 'info'; text: string } {
  if (!result) return { status: 'warn', text: '检测器异常，未验证' };
  if (!result.supported) return { status: 'info', text: '当前 WebView 不支持检测' };
  const { publicIps: ips } = result;
  // TUN 下所谓 direct 请求也会被接管，不能拿它当真实直连地址。
  if (!context.tun && context.direct && context.direct !== context.proxied && ips.includes(context.direct))
    return { status: 'bad', text: `发现直连公网候选 ${context.direct}` };
  if (ips.length) return { status: 'info', text: context.proxied && ips.every(ip => ip === context.proxied)
    ? '候选地址与代理出口一致（仅本应用）' : '发现公网候选，出口归属未确认' };
  if (result.status === 'error') return { status: 'warn', text: `WebRTC 初始化失败${result.detail ? `（${result.detail}）` : ''}` };
  if (result.scope === 'host') return result.status === 'complete'
    ? { status: 'ok', text: '本应用未发现公网本地候选' }
    : { status: 'warn', text: '本地候选收集超时，未完成验证' };
  if (result.status === 'timeout' || result.stunError) return context.blockWebRtc
    ? { status: 'info', text: 'STUN 无响应；已配置阻断，效果未验证' }
    : { status: 'warn', text: 'STUN 无响应，未完成验证' };
  return { status: 'ok', text: '本次未发现公网候选（仅本应用）' };
}

export async function checkWebRtc(timeoutMs = 7000, options: { stun?: boolean } = {}): Promise<WebRtcResult> {
  const scope = options.stun === false ? 'host' : 'stun';
  const PC = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  if (!PC) return { scope, supported: false, status: 'unsupported', publicIps: [] };

  return new Promise<WebRtcResult>((resolve) => {
    let pc: RTCPeerConnection;
    try {
      pc = new PC({ iceServers: scope === 'host' ? [] : [{ urls: 'stun:stun.l.google.com:19302' }] });
    } catch (error) {
      resolve({ scope, supported: true, status: 'error', publicIps: [], detail: error instanceof Error ? error.name : '初始化异常' });
      return;
    }

    let done = false;
    const ips = new Set<string>();
    let stunError: number | undefined;
    let detail: string | undefined;
    const finish = (status: WebRtcResult['status']) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.onicecandidate = null;
      pc.onicegatheringstatechange = null;
      pc.onicecandidateerror = null;
      try {
        pc.close();
      } catch {
        /* 已关闭 */
      }
      resolve({ scope, supported: true, status, publicIps: [...ips], stunError, detail });
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    pc.onicecandidate = (e) => {
      if (e.candidate === null) {
        // null candidate = 收集结束
        finish('complete');
        return;
      }
      const candidate = e.candidate;
      const fields = candidate?.candidate?.trim().split(/\s+/) ?? [];
      const type = candidate?.type ?? fields[fields.indexOf('typ') + 1];
      if (!['host', 'srflx', 'prflx'].includes(type)) return;
      const ip = publicAddress(candidate?.address ?? fields[4]);
      if (ip) ips.add(ip);
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') finish('complete');
    };
    pc.onicecandidateerror = e => { stunError = e.errorCode; };
    const fail = (error: unknown) => {
      detail = error instanceof Error ? error.name : '初始化异常';
      finish('error');
    };
    try {
      pc.createDataChannel('ppclash-check');
      pc.createOffer()
        .then((o) => { if (!done) return pc.setLocalDescription(o); })
        .then(() => { if (!done && pc.iceGatheringState === 'complete') finish('complete'); })
        .catch(fail);
    } catch (error) { fail(error); }
  });
}
