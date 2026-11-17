import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargoPackage = read('src-tauri/Cargo.toml').match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
const lockedPackage = read('src-tauri/Cargo.lock').split('[[package]]').find(block => /^name = "ppclash"$/m.test(block));
const version = (block: string | undefined) => block?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

it('package.json 包含有效的应用版本', () => {
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
});

it.each([
  ['package-lock.json', lock.version],
  ['package-lock.json packages.root', lock.packages?.['']?.version],
  ['src-tauri/tauri.conf.json', tauri.version],
  ['src-tauri/Cargo.toml', version(cargoPackage)],
  ['src-tauri/Cargo.lock ppclash', version(lockedPackage)],
])('%s 与 package.json 的应用版本一致', (_path, actual) => {
  expect(actual).toBe(pkg.version);
});
