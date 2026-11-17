#!/usr/bin/env node
// 直接复用应用内 BrandCat 的矢量轮廓，避免菜单栏出现另一只猫。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const component = readFileSync(resolve(root, 'src/components/BrandCat.tsx'), 'utf8');
const path = component.match(/d="(M0 0 [^"]+)"/)?.[1];
const transform = component.match(/<g transform="([^"]+)"/)?.[1];
if (!path || !transform) throw new Error('BrandCat 轮廓缺失');
const contours = path.trim().split(/ Z\s+(?=M)/);
if (contours.length !== 4) throw new Error('BrandCat 应包含头部、双眼与鼻子四个轮廓');
const eyes = `${contours[1]} Z ${contours[2]} Z`;
const svg = (body, eye) => `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="192 186 640 640"><g transform="${transform}">${eye ? `<path d="${eyes}" fill="${eye}"/>` : ''}<path d="${path}" fill="${body}" fill-rule="evenodd"/></g></svg>`;
const render = text => new Resvg(text).render().asPng();
const template = svg('#000000');
writeFileSync(resolve(root, 'src-tauri/icons/tray.svg'), template + '\n');
writeFileSync(resolve(root, 'src-tauri/icons/tray_icon.png'), render(template));
for (const [state, eye] of Object.entries({ off: '#8c96a6', proxy: '#78a5ff', tun: '#70d2ad' })) {
  for (const [theme, body] of Object.entries({ dark: '#f4f6fa', light: '#202936' })) {
    const png = render(svg(body, eye));
    writeFileSync(resolve(root, `src-tauri/resources/tray/${state}-${theme}.png`), png);
    if (theme === 'dark') writeFileSync(resolve(root, `src-tauri/resources/tray/${state}.png`), png);
  }
}
console.log('已生成同源猫头：关闭灰眼、系统代理蓝眼、TUN 绿眼，含明暗版本');
