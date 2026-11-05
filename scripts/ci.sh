#!/usr/bin/env bash
# 跨平台 CI 入口。
# GitHub Actions / GitLab CI / Woodpecker 只做 checkout、装工具链、然后调用这里。
# 这样换 CI 平台时不需要重写构建步骤。
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$PWD"
KERNEL_ZIP="$ROOT/src-tauri/resources/kernel.zip"

log() { printf '\n▸ %s\n' "$*"; }

ensure_kernel_placeholder() {
  [ -f "$KERNEL_ZIP" ] && return 0
  log "生成 kernel.zip 占位文件（仅用于 CI 编译/测试，不是发布包）"
  mkdir -p "$(dirname "$KERNEL_ZIP")"
  local py
  py="$(command -v python3 || command -v python || true)"
  if [ -z "$py" ]; then
    echo "需要 python3 生成 kernel.zip 占位文件" >&2
    return 1
  fi
  "$py" - "$KERNEL_ZIP" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("version.txt", "placeholder\n")
PY
}

install() {
  log "安装前端依赖"
  npm ci
}

build_web() {
  log "前端生产构建"
  npm run build
}

check_web() {
  log "TypeScript 类型检查"
  npx tsc --noEmit
  log "前端单元测试"
  npx vitest run
  log "前端生产构建"
  npm run build
}

check_rust() {
  ensure_kernel_placeholder
  if [ ! -d dist ]; then
    log "前端 dist 不存在，先构建"
    npm run build
  fi
  log "Rust 测试"
  cargo test --manifest-path src-tauri/Cargo.toml
}

check() {
  check_web
  check_rust
  scan
}

build_macos() {
  install
  ensure_kernel_placeholder
  log "macOS Universal 构建"
  UNIVERSAL=1 ./scripts/bundle.sh
}

build_macos_release() {
  install
  log "macOS Universal App"
  UNIVERSAL=1 ./scripts/bundle.sh
  log "macOS DMG"
  UNIVERSAL=1 ./scripts/build-dmg.sh
  local version
  version="$(node -p "require('./package.json').version")"
  local dmg
  dmg="$(find src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' -print -quit)"
  [ -n "$dmg" ] || { echo "找不到 DMG" >&2; exit 1; }
  mv "$dmg" "src-tauri/target/release/bundle/dmg/PP_Clash-${version}-macos-universal.dmg"
}

build_windows() {
  install
  ensure_kernel_placeholder
  log "Windows NSIS 构建"
  npm run tauri build
}

normalize_windows_installer() {
  local version
  version="$(node -p "require('./package.json').version")"
  local file
  file="$(find src-tauri/target/release/bundle/nsis -maxdepth 1 -name '*.exe' -print -quit)"
  [ -n "$file" ] || { echo "找不到 NSIS 安装包" >&2; exit 1; }
  mv "$file" "src-tauri/target/release/bundle/nsis/PP_Clash-${version}-windows-amd64-setup.exe"
}

build_windows_release() {
  install
  log "Windows NSIS 构建"
  npm run tauri build
  normalize_windows_installer
}

scan() {
  log "敏感信息扫描"
  ./scripts/secret-scan.sh
}

case "${1:-check}" in
  install) install ;;
  build-web) build_web ;;
  check-web) check_web ;;
  check-rust) check_rust ;;
  check) check ;;
  build-macos) build_macos ;;
  build-macos-release) build_macos_release ;;
  build-windows) build_windows ;;
  build-windows-release) build_windows_release ;;
  normalize-windows-installer) normalize_windows_installer ;;
  scan) scan ;;
  *)
    echo "用法: $0 {install|build-web|check-web|check-rust|check|build-macos|build-macos-release|build-windows|build-windows-release|normalize-windows-installer|scan}" >&2
    exit 2
    ;;
esac
