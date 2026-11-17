/** 只规范化地址文本，不进行 DNS 或网络请求。 */
export function isLoopbackAddress(address: string): boolean {
  const host = address.trim().replace(/^\[(.*)\]$/, '$1').split('%')[0];
  if (/^localhost\.?$/i.test(host)) return true;
  try {
    // URL 解析器统一压缩 IPv6 与映射 IPv4，避免仅匹配某种回环拼写。
    const normalized = new URL(`http://${host.includes(':') ? `[${host}]` : host}/`).hostname;
    if (normalized === '[::1]') return true;
    const mapped = /^\[::ffff:([0-9a-f]+):[0-9a-f]+\]$/i.exec(normalized);
    if (mapped) return (Number.parseInt(mapped[1], 16) >>> 8) === 127;
    return /^127(?:\.\d+){3}$/.test(normalized);
  } catch {
    return false;
  }
}
