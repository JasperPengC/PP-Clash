#!/usr/bin/env bash
# 在 macOS 上用 mingw-w64 交叉编译 Windows 测试 exe（不是正式安装包）。
# 需要：rustup target add x86_64-pc-windows-gnu；brew install mingw-w64
# 用法：./scripts/build-windows-gnu.sh [kernel-win.zip]
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:/usr/local/opt/mingw-w64/bin:$PATH"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc

rustup target add x86_64-pc-windows-gnu >/dev/null
npm run build
cargo build --release --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu

OUT="dist/windows-test"
rm -rf "$OUT"
mkdir -p "$OUT"
cp src-tauri/target/x86_64-pc-windows-gnu/release/ppclash.exe "$OUT/"
LOADER="$(find "$HOME/.cargo/registry/src" -path '*webview2-com-sys*/x64/WebView2Loader.dll' 2>/dev/null | head -1)"
[ -n "$LOADER" ] && cp "$LOADER" "$OUT/" || echo "警告：未找到 WebView2Loader.dll"
if [ -n "${1:-}" ] && [ -f "${1:-}" ]; then
  cp "$1" "$OUT/kernel.zip"
else
  echo "提示：正式运行前把 Windows 版 kernel.zip 放到 $OUT/kernel.zip"
fi
echo "✅ $OUT"
ls -lh "$OUT"
