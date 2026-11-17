#!/usr/bin/env bash
# 显式指定 OS / 架构时可在任意主机准备交叉构建资源；不从其他应用拷贝内核。
set -euo pipefail
cd "$(dirname "$0")/.."
os="${1:-$(uname -s)}"
arch="${2:-$(uname -m)}"
case "$os" in Darwin|macos) os=macos ;; Linux|linux) os=linux ;; MINGW*|MSYS*|windows) os=windows ;; *) echo "不支持的平台：$os" >&2; exit 1 ;; esac
case "$arch" in x86_64|amd64|AMD64) arch=x86_64 ;; arm64|aarch64|ARM64) arch=aarch64 ;; *) echo "不支持的架构：$arch" >&2; exit 1 ;; esac
py="$(command -v python3 || command -v python)"
exec "$py" scripts/prepare-resources.py "$os" "$arch" "${@:3}"
