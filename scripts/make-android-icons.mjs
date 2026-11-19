import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

/** Android 的裁切由启动器负责；前景保留 66/108 的安全区，不套桌面图标底板。 */
export function writeAndroidIcons(resources) {
  const source = readFileSync(new URL('../src-tauri/icons/tray.svg', import.meta.url), 'utf8');
  const path = source.match(/<path d="([^"]+)"/)?.[1];
  if (!path) throw new Error('Brand cat path is missing');
  const save = (file, content) => {
    const target = join(resources, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const vector = (size, viewport, scale, x, y, color) => `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${size}dp" android:height="${size}dp" android:viewportWidth="${viewport}" android:viewportHeight="${viewport}">
  <group android:scaleX="${scale}" android:scaleY="${scale}" android:translateX="${x}" android:translateY="${y}">
    <path android:pathData="${path}" android:fillColor="${color}" android:fillType="evenOdd" />
  </group>
</vector>
`;
  save('drawable/ppclash_icon_foreground.xml', vector(108, 108, .086109375, 28.03828125, 25.6426875, '#22252c'));
  save('drawable/ic_stat_ppclash.xml', vector(24, 640, .835, 68.25, 45.02, '#ffffff'));
  save('values/ppclash_icon.xml', '<?xml version="1.0" encoding="utf-8"?><resources><color name="ppclash_icon_background">#f4f6fa</color></resources>\n');
  for (const api of [26, 33]) {
    const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ppclash_icon_background" />
  <foreground android:drawable="@drawable/ppclash_icon_foreground" />
${api >= 33 ? '  <monochrome android:drawable="@drawable/ppclash_icon_foreground" />\n' : ''}</adaptive-icon>
`;
    for (const name of ['ic_launcher', 'ic_launcher_round']) save(`mipmap-anydpi-v${api}/${name}.xml`, adaptive);
  }

  const cat = `<g transform="translate(28.03828125 25.6426875) scale(.086109375)"><path d="${path}" fill="#22252c" fill-rule="evenodd"/></g>`;
  for (const [density, factor] of [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]) {
    for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
      const foreground = name.endsWith('foreground');
      const backdrop = foreground ? '' : name.endsWith('round')
        ? '<circle cx="54" cy="54" r="36" fill="#f4f6fa"/>'
        : '<rect x="18" y="18" width="72" height="72" rx="16" fill="#f4f6fa"/>';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${foreground ? '0 0 108 108' : '18 18 72 72'}">${backdrop}${cat}</svg>`;
      const size = (foreground ? 108 : 48) * factor;
      const png = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render().asPng();
      save(`mipmap-${density}/${name}.png`, png);
    }
  }
}
