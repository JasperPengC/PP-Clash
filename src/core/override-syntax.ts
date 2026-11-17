import yaml from 'js-yaml';
import { parse } from 'acorn';

export interface OverrideDiagnostic {
  from: number;
  to: number;
  line: number;
  column: number;
  message: string;
}

/** 与生成器使用同一 YAML 解析器；JS 只解析函数体，绝不执行用户代码。 */
export function validateOverrideSource(text: string, mode: 'yaml' | 'js'): OverrideDiagnostic[] {
  if (!text.trim()) return [];
  let message: string;
  let offset = 0;
  try {
    if (mode === 'js') {
      parse(`function __override__(config) {\n${text}\n}`, { ecmaVersion: 'latest', sourceType: 'script' });
    } else {
      const value = yaml.load(text);
      if (value == null || (value && typeof value === 'object' && !Array.isArray(value))) return [];
      return [diagnostic(text, 0, 'YAML 顶层需要是一个对象（键值对）')];
    }
    return [];
  } catch (error) {
    if (mode === 'yaml' && error instanceof yaml.YAMLException) {
      offset = error.mark?.position ?? 0;
      message = `YAML 语法错误：${error.reason}`;
    } else {
      const issue = error as { pos?: number; message?: string };
      offset = (issue.pos ?? 0) - 'function __override__(config) {\n'.length;
      message = `JS 语法错误：${issue.message?.replace(/ \(\d+:\d+\)$/, '') ?? '无法解析'}`;
    }
    return [diagnostic(text, offset, message)];
  }
}

function diagnostic(text: string, offset: number, message: string): OverrideDiagnostic {
  const from = Math.max(0, Math.min(text.length, offset));
  const before = text.slice(0, from);
  return { from, to: Math.min(text.length, from + 1), line: before.split('\n').length,
    column: from - before.lastIndexOf('\n'), message };
}
