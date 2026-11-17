#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const files = args => execFileSync('git', ['ls-files', '-z', ...args], { encoding: 'utf8' })
  .split('\0').filter(Boolean);

// A forced add must not bypass the repository's private-file exclusions.
const excluded = files(['--cached', '--ignored', '--exclude-standard']);
const productDocuments = new Set(['README.md', 'README.zh-CN.md', 'THIRD_PARTY_NOTICES.md']);
const documents = files(['--cached', '--others', '--exclude-standard'])
  .filter(file => /\.md$/i.test(file) && !productDocuments.has(file));
const rejected = [...new Set([...excluded, ...documents])].sort();

if (rejected.length) {
  console.error('公开文件检查未通过：以下本地资料不可进入仓库（请保留本地文件，仅取消 Git 跟踪）：');
  rejected.forEach(file => console.error(`  ${file}`));
  process.exitCode = 1;
} else {
  console.log('公开文件检查通过：未跟踪本地开发资料，仅保留产品文档。');
}
