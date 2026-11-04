#!/usr/bin/env bash
# 打包 macOS .app
#
# 为什么不用 `tauri build`：它在非 TTY 环境（CI、脚本、某些终端）下会静默退出，
# 什么都不输出也不报错。这里用 cargo 直接编译再手工组装 bundle，行为可控。
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

# 图标产物（icon.icns / icon.png / tray 状态图）已提交在 src-tauri/icons 与
# src-tauri/resources/tray；不要在这里重新生成，避免旧 SVG 覆盖新猫头。
[ -f src-tauri/icons/icon.png ] || { echo "缺少 src-tauri/icons/icon.png" >&2; exit 1; }
[ -f src-tauri/icons/icon.icns ] || { echo "缺少 src-tauri/icons/icon.icns" >&2; exit 1; }

echo "▸ 构建前端"
npm run build

APP="src-tauri/target/release/bundle/macos/PP Clash.app"
BIN="src-tauri/target/release/ppclash"

if [ "${UNIVERSAL:-0}" = "1" ]; then
  echo "▸ 编译 Rust (release, x86_64 + arm64)"
  rustup target add x86_64-apple-darwin aarch64-apple-darwin >/dev/null
  cargo build --release --target x86_64-apple-darwin --manifest-path src-tauri/Cargo.toml
  cargo build --release --target aarch64-apple-darwin --manifest-path src-tauri/Cargo.toml
  BIN="/tmp/ppclash-universal"
  lipo -create \
    src-tauri/target/x86_64-apple-darwin/release/ppclash \
    src-tauri/target/aarch64-apple-darwin/release/ppclash \
    -output "$BIN"
  echo "▸ Universal: $(file "$BIN")"
else
  echo "▸ 编译 Rust (release)"
  cargo build --release --manifest-path src-tauri/Cargo.toml
fi

echo "▸ 组装 $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ppclash"

cp src-tauri/icons/icon.icns "$APP/Contents/Resources/icon.icns"
mkdir -p "$APP/Contents/Resources/resources"
cp src-tauri/resources/kernel.zip "$APP/Contents/Resources/resources/kernel.zip"

echo "▸ 写 Info.plist"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>ppclash</string>
  <key>CFBundleIdentifier</key><string>com.ppclash.app</string>
  <key>CFBundleName</key><string>PP Clash</string>
  <key>CFBundleDisplayName</key><string>PP Clash</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "▸ 签名（adhoc）"
codesign --force --deep --sign - "$APP"

echo
echo "✅ 完成：$APP"
du -sh "$APP"
