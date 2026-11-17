#!/usr/bin/env node
// 同一矢量母版，分别设置桌面平台画布；不改写 macOS ICNS 和菜单栏资源。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'src-tauri/icons/icon.svg'), 'utf8');
const checking = process.argv.includes('--check');
const windowsSizes = [16, 20, 24, 32, 36, 40, 48, 64, 72, 96, 128, 256];
const linuxSizes = [16, 22, 24, 32, 48, 64, 96, 128, 256, 512];

function render(platform, size) {
  // Windows 桌面图标贴合自身画布，不沿用 macOS 的 Dock 透明安全区。
  const viewBox = platform === 'windows' ? '100 100 824 824' : '48 48 928 928';
  let svg = source.replace('viewBox="0 0 1024 1024"', `viewBox="${viewBox}"`);
  if (platform === 'windows') svg = svg.replace(' filter="url(#tileShadow)"', '');
  if (size <= 48) {
    svg = svg.replaceAll(/ filter="url\(#(?:tileShadow|catShadow)\)"/g, '')
      .replace(/\s*<rect[^>]+fill="url\(#sheen\)"[^>]*\/>/, '');
  }
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render().asPng();
}

function renderInstaller(size) {
  let body = source.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
    .replace(' filter="url(#tileShadow)"', '');
  if (size <= 48) body = body.replace(' filter="url(#catShadow)"', '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <svg x="16" y="16" width="820" height="820" viewBox="100 100 824 824">${body}</svg>
    <circle cx="792" cy="792" r="216" fill="#3478f6" stroke="#f5f7fb" stroke-width="16"/>
    <path d="M792 648v176m-72-64 72 72 72-72M690 868v42h204v-42" fill="none" stroke="white" stroke-width="48" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render().asPng();
}

function ico(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  for (const [i, { size, png }] of frames.entries()) {
    const entry = 6 + i * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  }
  return Buffer.concat([header, ...frames.map(frame => frame.png)]);
}

function save(relative, bytes) {
  const target = resolve(root, relative);
  if (checking) {
    if (!readFileSync(target).equals(bytes)) throw new Error(`图标资源未同步：${relative}`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

save('src-tauri/icons/icon.ico', ico(windowsSizes.map(size => ({ size, png: render('windows', size) }))));
save('src-tauri/icons/installer.ico', ico(windowsSizes.map(size => ({ size, png: renderInstaller(size) }))));
for (const size of linuxSizes) save(`src-tauri/icons/linux/${size}x${size}.png`, render('linux', size));
console.log(`${checking ? '校验' : '生成'}完成：Windows ICO ${windowsSizes.join('/')}px；Linux PNG ${linuxSizes.join('/')}px`);
