#!/usr/bin/env bash
# 构建 Intel + Apple Silicon 通用 .app 和 DMG。
# 需要 rustup 的两个 macOS target；Xcode CLT 即可。
set -euo pipefail
cd "$(dirname "$0")/.."
UNIVERSAL=1 ./scripts/bundle.sh
UNIVERSAL=1 ./scripts/build-dmg.sh
