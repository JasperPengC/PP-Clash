#!/usr/bin/env node
/**
 * 从矢量母版 icon.svg 生成全套 macOS 图标并合成 .icns。
 *
 * 相比 make-icon-raster.py 的位图缩小：SVG 在每个尺寸直接栅格化更锐利，
 * 且母版自带 Apple 规范的透明边距（824/1024），缩放后边距比例不变、保持 RGBA。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src-tauri/icons/icon.svg');
const TRAY_SRC = path.join(ROOT, 'src-tauri/icons/tray.svg');
const ICONSET = '/tmp/ppclash.iconset';

// Apple 标准命名：每个逻辑尺寸的 1x / 2x
const sizes = {
  16: ['icon_16x16.png'],
  32: ['icon_16x16@2x.png', 'icon_32x32.png'],
  64: ['icon_32x32@2x.png'],
  128: ['icon_128x128.png'],
  256: ['icon_128x128@2x.png', 'icon_256x256.png'],
  512: ['icon_256x256@2x.png', 'icon_512x512.png'],
  1024: ['icon_512x512@2x.png'],
};

const svg = readFileSync(SRC, 'utf8');
const renderPng = (svgText, size) =>
  new Resvg(svgText, { fitTo: { mode: 'width', value: size } }).render().asPng();

rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });

for (const [size, names] of Object.entries(sizes)) {
  const png = renderPng(svg, Number(size));
  for (const name of names) writeFileSync(path.join(ICONSET, name), png);
}

// icon.png 必须 RGBA（tauri::generate_context! 要求，否则 Rust 编译 panic）
writeFileSync(path.join(ROOT, 'src-tauri/icons/icon.png'), renderPng(svg, 1024));

// 托盘模板图标：黑色猫头 + 透明（lib.rs 里 icon_as_template，系统自适应明暗菜单栏）
const traySvg = readFileSync(TRAY_SRC, 'utf8');
writeFileSync(path.join(ROOT, 'src-tauri/icons/tray_icon.png'), renderPng(traySvg, 44));

// 侧边栏品牌图：同一母版改为满幅圆角（无 macOS 边距），保持应用内外品牌一致
const brandSvg = svg
  .replaceAll('x="36" y="36" width="952" height="952" rx="215"', 'x="0" y="0" width="1024" height="1024" rx="232"')
  .replace('x="37.5" y="37.5" width="949" height="949" rx="213.5"', 'x="1.5" y="1.5" width="1021" height="1021" rx="230.5"');
writeFileSync(path.join(ROOT, 'src/assets/brand-cat.png'), renderPng(brandSvg, 128));

execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', path.join(ROOT, 'src-tauri/icons/icon.icns')]);
console.log(`✅ 生成 icon.icns（含尺寸：${Object.keys(sizes).join(', ')}）+ RGBA icon.png + 托盘模板 + 侧边栏品牌图`);
