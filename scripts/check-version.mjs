import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(resolve(root, path), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml').match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
const crate = read('src-tauri/Cargo.lock').split('[[package]]').find(block => /^name = "ppclash"$/m.test(block));
const version = block => block?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const sources = {
  'package-lock.json': lock.version,
  'package-lock.json packages.root': lock.packages?.['']?.version,
  'src-tauri/tauri.conf.json': tauri.version,
  'src-tauri/Cargo.toml': version(cargo),
  'src-tauri/Cargo.lock ppclash': version(crate),
};
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) {
  throw new Error('package.json 缺少有效版本');
}
const mismatch = Object.entries(sources).filter(([, value]) => value !== pkg.version);
if (mismatch.length) {
  throw new Error(`版本不一致；预期 ${pkg.version}：\n${mismatch.map(([path, value]) => `${path}: ${value ?? '缺失'}`).join('\n')}`);
}
console.log(`版本一致：${pkg.version}（package、锁文件、Tauri、Cargo）`);
