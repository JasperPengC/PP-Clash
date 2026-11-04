import { isWindows } from '../core/platform';

/**
 * Windows 的 Segoe UI Emoji 不渲染国旗 emoji，会退化成 "US" 两个字母。
 * 这里把国旗换成统一的两位国家码徽标，Mac 保持原生 emoji。
 */
export function splitFlag(name: string): { code: string | null; rest: string } {
  const m = name.match(/^([\u{1F1E6}-\u{1F1FF}]{2})\s*/u);
  if (!m) return { code: null, rest: name };
  const code = [...m[1]]
    .map((ch) => String.fromCharCode(ch.codePointAt(0)! - 0x1f1e6 + 65))
    .join('');
  return { code, rest: name.slice(m[0].length) };
}

export function NodeName({ name, className }: { name: string; className?: string }) {
  if (!isWindows) return <span className={className}>{name}</span>;
  const { code, rest } = splitFlag(name);
  if (!code) return <span className={className}>{name}</span>;
  return (
    <span className={`node-name-with-code${className ? ` ${className}` : ''}`}>
      <span className={`fi fi-${code.toLowerCase()} node-flag-icon`} aria-hidden="true" />
      <span>{rest}</span>
    </span>
  );
}
