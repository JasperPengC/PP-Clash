import { expect, it } from 'vitest';
import { parseLogLine } from '../src/core/log-format';

it('分离纳秒时间与级别，正文解码，额外字段原样保留', () => {
  const raw = 'time="2026-11-08T12:34:56.123456789+08:00" level=warning msg="dial \\"example.test\\" failed" source=tcp retry=3';
  expect(parseLogLine(raw)).toEqual({ raw, time: '12:34:56', timestamp: '2026-11-08T12:34:56.123456789+08:00', level: 'warn', message: 'dial "example.test" failed', details: 'source=tcp retry=3' });
});

it('不带时间也能分级，支持 fatal 和引号里的 level= 文本', () => {
  expect(parseLogLine('level=fatal msg="upstream level=warn unavailable"').level).toBe('error');
  expect(parseLogLine('level=info msg="level=error is a field"').level).toBe('info');
});

it.each(['panic: unexpected EOF', '  at /core/main.go:42', 'time=bad level=info msg="unterminated', 'level=notice msg="unknown"'])('非结构化或不完整日志无损回退：%s', raw => {
  expect(parseLogLine(raw)).toEqual({ raw, time: '', timestamp: '', level: 'plain', message: raw, details: '' });
});

it('保留换行转义、反斜杠及正文前后的额外字段', () => {
  const parsed = parseLogLine('source=udp level=debug msg="first\\nsecond \\\\ path" count=2');
  expect(parsed.message).toBe('first\nsecond \\ path');
  expect(parsed.details).toBe('source=udp count=2');
});
