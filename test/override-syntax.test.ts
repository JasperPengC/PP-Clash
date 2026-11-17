import { describe, expect, it } from 'vitest';
import { validateOverrideSource } from '../src/core/override-syntax';

describe('覆写语法校验', () => {
  it('接受 YAML 映射、JSON 和仅注释内容，拒绝顶层数组与标量', () => {
    for (const text of ['dns:\n  nameserver: [https://dns.google/dns-query]', '{"mode":"rule"}', '# 注释\n']) {
      expect(validateOverrideSource(text, 'yaml')).toEqual([]);
    }
    for (const text of ['- one\n- two', 'hello']) {
      expect(validateOverrideSource(text, 'yaml')[0].message).toContain('键值对');
    }
  });
  it('给出 YAML 错误的真实行列和可定位范围', () => {
    const text = 'dns:\n  nameserver: [one\n  fallback: two';
    const [error] = validateOverrideSource(text, 'yaml');
    expect(error.line).toBe(3);
    expect(error.column).toBeGreaterThan(0);
    expect(text.slice(error.from, error.to)).not.toBe('');
    expect(error.line).toBeGreaterThanOrEqual(2);
    expect(error.to).toBeLessThanOrEqual(text.length);
  });
  it('按函数体校验 JS，接受 return config，不执行任何脚本', () => {
    expect(validateOverrideSource('config.mode = "global"; return config;', 'js')).toEqual([]);
    expect(validateOverrideSource('while (true) {}\nthrow new Error("不得执行");', 'js')).toEqual([]);
    expect(validateOverrideSource('const config = {};', 'js')[0].message).toContain('already');
    expect(validateOverrideSource('import x from "x";', 'js')).toHaveLength(1);
  });
  it('JS 错误位置不包含校验包装行，并限制到原文范围', () => {
    const text = 'config.mode = "rule";\nconst value = ;\nreturn config;';
    const [error] = validateOverrideSource(text, 'js');
    expect(error.line).toBe(2);
    expect(error.column).toBe(15);
    expect(error.from).toBe(text.indexOf(';', text.indexOf('const')));
    const incomplete = 'if (true) {';
    const [end] = validateOverrideSource(incomplete, 'js');
    expect(end.from).toBeLessThanOrEqual(incomplete.length);
    expect(end.line).toBe(1);
  });
  it('拒绝 YAML 重复键，修复后不保留旧诊断', () => {
    expect(validateOverrideSource('mode: rule\nmode: global', 'yaml')).toHaveLength(1);
    expect(validateOverrideSource('mode: global', 'yaml')).toEqual([]);
  });
});
