#!/usr/bin/env bash
# 打包 macOS .app
#
# 为什么不用 `tauri build`：它在非 TTY 环境（CI、脚本、某些终端）下会静默退出，
# 什么都不输出也不报错。这里用 cargo 直接编译再手工组装 bundle，行为可控。
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

# 关键：图标生成必须放在 cargo build 之前！
# tauri::generate_context!() 在编译期读取 src-tauri/icons/icon.png，
# 且该 PNG 必须是 RGBA（否则 Rust 宏 panic）。如果 icon 在 cargo 之后生成，
# cargo 会用到上一次残留的（可能是 RGB 的）icon.png 而失败。
echo "▸ 生成图标（icon.svg 矢量母版 → 多尺寸 icns / RGBA icon.png）"
node scripts/make-icon.mjs

echo "▸ 构建前端"
npm run build

echo "▸ 编译 Rust (release)"
cargo build --release --manifest-path src-tauri/Cargo.toml

APP="src-tauri/target/release/bundle/macos/PPClash.app"
echo "▸ 组装 $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp src-tauri/target/release/ppclash "$APP/Contents/MacOS/ppclash"

cp src-tauri/icons/icon.icns "$APP/Contents/Resources/icon.icns"

echo "▸ 写 Info.plist"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>ppclash</string>
  <key>CFBundleIdentifier</key><string>com.ppclash.app</string>
  <key>CFBundleName</key><string>PPClash</string>
  <key>CFBundleDisplayName</key><string>PPClash</string>
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
