import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargoPackage = read('src-tauri/Cargo.toml').match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
const lockedPackage = read('src-tauri/Cargo.lock').split('[[package]]').find(block => /^name = "ppclash"$/m.test(block));
const version = (block: string | undefined) => block?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

it.each([
  ['package.json', pkg.version],
  ['package-lock.json', lock.version],
  ['package-lock.json packages.root', lock.packages?.['']?.version],
  ['src-tauri/tauri.conf.json', tauri.version],
  ['src-tauri/Cargo.toml', version(cargoPackage)],
  ['src-tauri/Cargo.lock ppclash', version(lockedPackage)],
])('%s 的应用版本为 0.2.0', (_path, actual) => {
  expect(actual).toBe('0.2.0');
});
