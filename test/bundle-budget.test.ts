import { expect, it } from 'vitest';
import { inspectInitialDependencies } from '../scripts/bundle-budget.mjs';

it('预算累计静态依赖闭包，不能通过把大依赖挪到 vendor 绕过', () => {
  const chunks = {
    'entry.js': { bytes: 10, imports: ['vendor.js'], modules: ['src/main.tsx'] },
    'vendor.js': { bytes: 700_000, imports: ['entry.js'], modules: ['node_modules/editor/index.js'] },
    'later.js': { bytes: 800_000, imports: [], modules: ['src/pages/Override.tsx'] },
  };
  expect(inspectInitialDependencies(chunks, 'entry.js')).toEqual({ bytes: 700_010, files: ['entry.js', 'vendor.js'], modules: ['src/main.tsx', 'node_modules/editor/index.js'] });
});
