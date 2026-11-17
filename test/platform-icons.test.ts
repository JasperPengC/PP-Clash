import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { expect, it } from 'vitest';

it('Windows ICO 为常见 DPI 提供独立尺寸，包含小图标和256px图层', () => {
  const ico = readFileSync('src-tauri/icons/icon.ico');
  expect(ico.readUInt16LE(2)).toBe(1);
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
    const entry = 6 + i * 16;
    const size = ico[entry] || 256;
    expect(ico[entry + 1] || 256).toBe(size);
    const start = ico.readUInt32LE(entry + 12);
    const length = ico.readUInt32LE(entry + 8);
    expect(start + length).toBeLessThanOrEqual(ico.length);
    expect(ico.subarray(start, start + 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(ico.readUInt32BE(start + 16)).toBe(size);
    expect(ico.readUInt32BE(start + 20)).toBe(size);
    return size;
  });
  expect(sizes).toEqual([16, 20, 24, 32, 36, 40, 48, 64, 72, 96, 128, 256]);
});

it('Windows 图标在桌面常用尺寸占满画布，安装器与应用使用不同图标', () => {
  const app = readFileSync('src-tauri/icons/icon.ico');
  const setup = readFileSync('src-tauri/icons/installer.ico');
  expect(setup).not.toEqual(app);
  expect(setup.readUInt16LE(4)).toBe(app.readUInt16LE(4));
  const config = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json', 'utf8'));
  expect(config.bundle.windows.nsis.installerIcon).toBe('icons/installer.ico');
  expect(config.bundle.icon).toContain('icons/icon.ico');
  for (let i = 0; i < app.readUInt16LE(4); i++) {
    const entry = 6 + 16 * i;
    const size = app[entry] || 256;
    if (![32, 48, 64, 256].includes(size)) continue;
    const length = app.readUInt32LE(entry + 8), start = app.readUInt32LE(entry + 12);
    const png = app.subarray(start, start + length);
    const rendered = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image width="${size}" height="${size}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`, { font: { loadSystemFonts: false } }).render();
    const pixels = rendered.pixels;
    const alpha = (x: number, y: number) => pixels[(y * size + x) * 4 + 3];
    const solid = Array.from({ length: size }, (_, x) => alpha(x, Math.floor(size / 2))).filter(value => value > 200).length;
    expect(solid / size).toBeGreaterThanOrEqual(0.97);
    expect(alpha(0, 0)).toBeLessThan(10);
  }
});

it('Linux 安装配置覆盖桌面菜单与高DPI尺寸，图层保持RGBA', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.linux.conf.json', 'utf8'));
  const sizes = config.bundle.icon.map((name: string) => {
    const png = readFileSync(`src-tauri/${name}`);
    const size = png.readUInt32BE(16);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png[25]).toBe(6);
    expect(name).toContain('/linux/');
    return size;
  });
  expect(sizes).toEqual([128, 16, 22, 24, 32, 48, 64, 96, 256, 512]);
});
