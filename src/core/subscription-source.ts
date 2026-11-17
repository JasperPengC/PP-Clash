/** 订阅来源在表单和数据层使用同一套规范，避免非法或重复来源被导入。 */
export function normalizeSubscriptionUrl(value: string): string {
  const text = value.trim();
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || /\s/.test(text)) throw new Error();
    return url.href;
  } catch {
    throw new Error('请输入有效的 http:// 或 https:// 订阅链接');
  }
}

export function sameSubscriptionUrl(left: string, right: string): boolean {
  try { return normalizeSubscriptionUrl(left) === normalizeSubscriptionUrl(right); }
  catch { return false; }
}
