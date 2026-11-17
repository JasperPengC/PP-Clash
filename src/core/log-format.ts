export type LogLevel = 'plain' | 'info' | 'warn' | 'error' | 'debug';
export interface LogEntry {
  raw: string;
  time: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  details: string;
}

const LEVELS: Record<string, LogLevel> = { info: 'info', warning: 'warn', warn: 'warn', error: 'error', fatal: 'error', panic: 'error', debug: 'debug', trace: 'debug' };

/** 原文回退仍按顶层 level 字段筛选，忽略 msg 内的同名文本和特殊 Go 转义。 */
export function logLineLevel(entry: LogEntry): LogLevel {
  if (entry.level !== 'plain') return entry.level;
  const token = /\s*(\w+)=("(?:\\.|[^"\\])*"|[^\s"]+)(?=\s|$)/gy;
  let match: RegExpExecArray | null;
  while ((match = token.exec(entry.raw))) {
    if (match[1] === 'level') return LEVELS[match[2].replace(/^"|"$/g, '').toLowerCase()] ?? 'plain';
  }
  return 'plain';
}

/** 仅解析完整 logfmt 行；无法确定格式时原样显示，绝不吞掉诊断内容。 */
export function parseLogLine(raw: string): LogEntry {
  const fallback: LogEntry = { raw, time: '', timestamp: '', level: 'plain', message: raw, details: '' };
  const fields: Array<{ key: string; value: string; raw: string }> = [];
  const token = /(\w+)=("(?:\\.|[^"\\])*"|[^\s"]+)(?=\s|$)/gy;
  let offset = 0;
  try {
    while (offset < raw.length) {
      offset += raw.slice(offset).match(/^\s*/)?.[0].length ?? 0;
      if (offset === raw.length) break;
      token.lastIndex = offset;
      const match = token.exec(raw);
      if (!match) return fallback;
      fields.push({ key: match[1], value: match[2].startsWith('"') ? JSON.parse(match[2]) : match[2], raw: match[0] });
      offset = token.lastIndex;
    }
  } catch { return fallback; }
  const values = Object.fromEntries(fields.map(field => [field.key, field.value]));
  const level = LEVELS[values.level?.toLowerCase()];
  if (!level || values.msg === undefined || ['time', 'level', 'msg'].some(key => fields.filter(field => field.key === key).length > 1)) return fallback;
  const time = values.time?.match(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)?.[1];
  if (values.time && !time) return fallback;
  return {
    raw, time: time ?? '', timestamp: values.time ?? '', level, message: values.msg,
    details: fields.filter(field => !['time', 'level', 'msg'].includes(field.key)).map(field => field.raw).join(' '),
  };
}
