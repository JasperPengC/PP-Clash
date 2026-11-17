#!/usr/bin/env bash
# 构建 macOS DMG：品牌背景、固定 Finder 布局和 Applications 拖入安装。
#
# 依赖：bundle.sh 的 .app、macOS 命令行工具、Node 与 Python（固定版本依赖见 dmg-requirements.txt）。
# 用法：./scripts/build-dmg.sh
# 可选环境变量：APP_PATH（默认 bundle 输出路径）、DMG_PYTHON（默认 python3）
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/macos-resource-gate.sh
require_macos_package_mode

APP_DEFAULT="src-tauri/target/release/bundle/macos/PP Clash.app"
APP_PATH="${APP_PATH:-$APP_DEFAULT}"
if [ ! -d "$APP_PATH" ]; then
  echo "▸ 未找到 $APP_PATH，先运行 scripts/bundle.sh"
  ./scripts/bundle.sh
fi
[ -d "$APP_PATH" ] || { echo "打包失败：$APP_PATH 不存在" >&2; exit 1; }
validate_macos_bundle_resources "$APP_PATH/Contents/Resources/resources/kernel.zip"

VERSION="$(node -e "console.log(require('./src-tauri/tauri.conf.json').version)")"
ARCH="$(macos_resource_arch)"
PACKAGE_NAME="PP_Clash-${VERSION}-macos-${ARCH}"
STAGE="$(mktemp -d)"
MOUNT="$STAGE/mount"
MOUNTED=0
cleanup() {
  if [ "$MOUNTED" = 1 ]; then hdiutil detach "$MOUNT" -quiet || hdiutil detach "$MOUNT" -force -quiet || true; fi
  rm -rf "$STAGE"
}
trap cleanup EXIT
DMG_PYTHON="${DMG_PYTHON:-python3}"
if ! "$DMG_PYTHON" -c 'import ds_store, mac_alias' >/dev/null 2>&1; then
  "$DMG_PYTHON" -m pip install --disable-pip-version-check --target "$STAGE/python" -r scripts/dmg-requirements.txt
  export PYTHONPATH="$STAGE/python${PYTHONPATH:+:$PYTHONPATH}"
fi
mkdir -p "$STAGE/PP Clash"
ditto "$APP_PATH" "$STAGE/PP Clash/PP Clash.app"
ln -s /Applications "$STAGE/PP Clash/Applications"
mkdir -p "$STAGE/PP Clash/.background"
node scripts/make-dmg-background.mjs "$STAGE/background.png"
/usr/bin/tiffutil -cathidpicheck "$STAGE/background.png" "$STAGE/background@2x.png" -out "$STAGE/PP Clash/.background/background.tiff"
/usr/bin/swift -suppress-warnings scripts/make-dmg-icon.swift src-tauri/icons/icon.icns "$STAGE/icon"
/usr/bin/iconutil -c icns "$STAGE/icon/installer.iconset" -o "$STAGE/icon/installer.icns"
cp "$STAGE/icon/installer.icns" "$STAGE/PP Clash/.VolumeIcon.icns"

OUT_DIR="src-tauri/target/release/bundle/dmg"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/${PACKAGE_NAME}.dmg"
echo "▸ 生成 DMG：$OUT"
hdiutil create -volname "$PACKAGE_NAME" -fs HFS+ -srcfolder "$STAGE/PP Clash" -format UDRW "$STAGE/installer.dmg"
mkdir -p "$MOUNT"
hdiutil attach "$STAGE/installer.dmg" -nobrowse -noautoopen -mountpoint "$MOUNT" -quiet
MOUNTED=1
/usr/bin/swift -suppress-warnings scripts/make-dmg-bookmark.swift "$MOUNT/.background/background.tiff" "$STAGE/background-ref"
"$DMG_PYTHON" scripts/layout-dmg.py "$MOUNT" "$STAGE/background-ref"
/usr/bin/SetFile -a C "$MOUNT"
hdiutil detach "$MOUNT" -quiet
MOUNTED=0
hdiutil convert "$STAGE/installer.dmg" -format UDZO -imagekey zlib-level=9 -ov -o "$OUT"
/usr/bin/swift -suppress-warnings scripts/set-macos-file-icon.swift "$STAGE/icon/installer.icns" "$OUT"
echo "✅ 完成：$OUT"
ls -lh "$OUT"
