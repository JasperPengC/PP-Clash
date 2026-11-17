import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkArchitecture } from '../scripts/check-architecture.mjs';

const fixtures: string[] = [];
afterEach(() => { fixtures.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })); });
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'ppclash-architecture-')); fixtures.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, content);
  }
  return root;
}

it('实际项目满足分层边界与静态运行时无环约束', () => {
  expect(checkArchitecture().errors).toEqual([]);
});

it('拒绝底层通过类型引用依赖 store，但合法的纯类型环不当作运行时环', () => {
  const root = fixture({ 'domain/a.ts': "export type A = import('../store/app').State;", 'store/app.ts': 'export interface State {}' });
  expect(checkArchitecture(root).errors).toHaveLength(1);
  expect(checkArchitecture(root).errors[0]).toContain('底层模块向上依赖');
  const types = fixture({ 'core/a.ts': "import type { B } from './b'; export interface A { b: B }", 'core/b.ts': "import type { A } from './a'; export interface B { a: A }" });
  expect(checkArchitecture(types).errors).toEqual([]);
});

it('拒绝重导出形成的静态运行时循环', () => {
  const root = fixture({ 'a.ts': "export { b } from './b'; export const a = 1;", 'b.ts': "import { a } from './a'; export const b = a;" });
  expect(checkArchitecture(root).errors.some(error => error.includes('运行时循环依赖'))).toBe(true);
});
