/**
 * WebRTC 泄漏自检（前端侧，M3-3 的一部分）。
 *
 * 在 WebView 里用 STUN 收集 srflx 候选：能拿到公网 IP 说明打洞没被拦住。
 * 结果交给 UI 与直连 / 代理出口 IP 对比后定性。
 * WKWebView 不一定有 RTCPeerConnection，不支持时诚实返回 supported: false。
 */

export interface WebRtcResult {
  supported: boolean;
  publicIps: string[];
}

export async function checkWebRtc(timeoutMs = 7000): Promise<WebRtcResult> {
  const PC = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  if (!PC) return { supported: false, publicIps: [] };

  return new Promise<WebRtcResult>((resolve) => {
    let pc: RTCPeerConnection;
    try {
      pc = new PC({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    } catch {
      resolve({ supported: false, publicIps: [] });
      return;
    }

    let done = false;
    const ips = new Set<string>();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch {
        /* 已关闭 */
      }
      resolve({ supported: true, publicIps: [...ips] });
    };

    const timer = setTimeout(finish, timeoutMs);

    pc.onicecandidate = (e) => {
      const c = e?.candidate?.candidate;
      if (!c) {
        // null candidate = 收集结束
        finish();
        return;
      }
      if (c.includes('typ srflx') || c.includes('typ prflx')) {
        for (const ip of c.match(/\d{1,3}(?:\.\d{1,3}){3}/g) ?? []) {
          if (ip !== '0.0.0.0') ips.add(ip);
        }
      }
    };
    pc.createDataChannel('ppclash-check');
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(finish);
  });
}
