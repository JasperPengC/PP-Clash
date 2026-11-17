#!/usr/bin/env bash
# 由 bundle.sh / build-dmg.sh 引用；调用方已进入仓库根目录。
macos_resource_arch() {
  case "${MACOS_TARGET:-$(uname -m)}" in
    x86_64|x86_64-apple-darwin) printf '%s\n' x86_64 ;;
    arm64|aarch64|aarch64-apple-darwin) printf '%s\n' aarch64 ;;
    *) echo "不支持的 macOS 打包目标：${MACOS_TARGET:-unknown}" >&2; return 1 ;;
  esac
}

require_macos_package_mode() {
  [ "${PPCLASH_COMPILE_ONLY:-0}" = "0" ] || { echo "compile-only 模式只检查编译，禁止生成 .app / DMG" >&2; return 1; }
  [ "${UNIVERSAL:-0}" = "0" ] || { echo "当前资源格式只有单架构内核，禁止 Universal 发布包；双架构编译请显式设置 PPCLASH_COMPILE_ONLY=1" >&2; return 1; }
}

validate_macos_bundle_resources() {
  require_macos_package_mode || return 1
  local arch py
  arch="$(macos_resource_arch)" || return 1
  py="$(command -v python || command -v python3)" || return 1
  [ -n "${KERNEL_ZIP_SHA256:-}" ] || { echo "必须配置独立受信任的 KERNEL_ZIP_SHA256" >&2; return 1; }
  "$py" scripts/validate-resources.py "$1" macos "$arch" --sha256 "$KERNEL_ZIP_SHA256"
}
