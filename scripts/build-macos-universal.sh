#!/usr/bin/env bash
# 旧入口仅保留 Intel + Apple Silicon 编译检查，不输出混用单架构内核的安装包。
# 两种正式安装包请分别使用 ci.sh build-macos-release 和对应架构资源。
set -euo pipefail
cd "$(dirname "$0")/.."
PPCLASH_COMPILE_ONLY=1 UNIVERSAL=1 ./scripts/bundle.sh
