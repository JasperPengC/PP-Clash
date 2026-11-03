#!/usr/bin/env bash
# 构建 macOS DMG：先产出 .app，再把 .app 和 Applications 快捷方式打进 DMG。
#
# 依赖：scripts/bundle.sh 能成功产出 .app、系统有 hdiutil。
# 用法：./scripts/build-dmg.sh
# 可选环境变量：APP_PATH（默认 bundle 输出路径）
set -euo pipefail
cd "$(dirname "$0")/.."

APP_DEFAULT="src-tauri/target/release/bundle/macos/PPClash.app"
APP_PATH="${APP_PATH:-$APP_DEFAULT}"
if [ ! -d "$APP_PATH" ]; then
  echo "▸ 未找到 $APP_PATH，先运行 scripts/bundle.sh"
  ./scripts/bundle.sh
fi
[ -d "$APP_PATH" ] || { echo "打包失败：$APP_PATH 不存在" >&2; exit 1; }

VERSION="$(node -e "console.log(require('./src-tauri/tauri.conf.json').version)")"
ARCH="$(uname -m)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/PP Clash"
cp -R "$APP_PATH" "$STAGE/PP Clash/PP Clash.app"
ln -s /Applications "$STAGE/PP Clash/Applications"

OUT_DIR="src-tauri/target/release/bundle/dmg"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/PP Clash_${VERSION}_${ARCH}.dmg"
rm -f "$OUT"
echo "▸ 生成 DMG：$OUT"
hdiutil create -volname "PP Clash" -srcfolder "$STAGE/PP Clash" -ov -format UDZO "$OUT"
echo "✅ 完成：$OUT"
ls -lh "$OUT"
