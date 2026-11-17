import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

// 安装窗口直接复用产品猫头，不另造品牌图形。
const brand = readFileSync(new URL('../src/components/BrandCat.tsx', import.meta.url), 'utf8');
const path = brand.match(/d="(M0 0[^"]+)"/)?.[1];
if (!path) throw new Error('未找到产品猫头路径');
const cat = `<svg viewBox="192 186 640 640"><g transform="translate(260.25 231.02) scale(0.835)"><path d="${path}" fill="currentColor" fill-rule="evenodd"/></g></svg>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="460" viewBox="0 0 720 460">
  <defs><filter id="soft-cat" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter></defs>
  <rect width="720" height="460" fill="#f7f8fa"/>
  <g color="#b8c7da" opacity="0.28" filter="url(#soft-cat)"><svg x="300" y="-12" width="490" height="490">${cat}</svg></g>
  <g font-family="Helvetica Neue, PingFang SC, Arial, sans-serif">
    <text x="48" y="68" fill="#22252d" font-size="25" font-weight="600">PP Clash</text>
    <text x="672" y="65" text-anchor="end" fill="#626773" font-size="13">macOS</text>
    <text x="48" y="120" fill="#626773" font-size="16">拖入 Applications，开始使用。</text>
    <path d="M327 252h66m-12-12 12 12-12 12" fill="none" stroke="#9aa6b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M48 366h624" stroke="#e9edf1"/>
    <text x="360" y="403" text-anchor="middle" fill="#626773" font-size="13">安装后，可弹出此磁盘映像。</text>
  </g>
</svg>`;
const output = process.argv[2];
if (!output) throw new Error('用法：node scripts/make-dmg-background.mjs <输出 PNG>');
writeFileSync(output, new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
writeFileSync(output.replace(/\.png$/, '@2x.png'), new Resvg(svg, {
  font: { loadSystemFonts: true }, fitTo: { mode: 'width', value: 1440 },
}).render().asPng());
