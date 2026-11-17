#!/usr/bin/env bash
# 在 macOS 上用 mingw-w64 交叉编译 Windows 测试 exe（不是正式安装包）。
# 需要：rustup target add x86_64-pc-windows-gnu；brew install mingw-w64
# 用法：./scripts/build-windows-gnu.sh [kernel-win.zip]
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:/usr/local/opt/mingw-w64/bin:$PATH"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc

RESOURCE_ZIP="${1:-src-tauri/resources/kernel.zip}"
PYTHON="$(command -v python3 || command -v python)"
[ -n "${KERNEL_ZIP_SHA256:-}" ] || { echo "必须配置独立受信任的 KERNEL_ZIP_SHA256" >&2; exit 1; }
"$PYTHON" scripts/validate-resources.py "$RESOURCE_ZIP" windows x86_64 --sha256 "$KERNEL_ZIP_SHA256"

rustup target add x86_64-pc-windows-gnu >/dev/null
npm run build
cargo build --locked --release --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu

OUT="dist/windows-test"
rm -rf "$OUT"
mkdir -p "$OUT"
cp src-tauri/target/x86_64-pc-windows-gnu/release/ppclash.exe "$OUT/"
LOADER="$(find "$HOME/.cargo/registry/src" -path '*webview2-com-sys*/x64/WebView2Loader.dll' -print -quit 2>/dev/null)"
[ -n "$LOADER" ] && cp "$LOADER" "$OUT/" || echo "警告：未找到 WebView2Loader.dll"
cp "$RESOURCE_ZIP" "$OUT/kernel.zip"
echo "✅ $OUT"
ls -lh "$OUT"
