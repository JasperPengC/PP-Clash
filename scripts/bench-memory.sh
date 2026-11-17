#!/usr/bin/env bash
# 只读采样；支持 --seconds、--pid LABEL=PID 和 --json PATH。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$SCRIPT_DIR/bench-memory.py" "$@"
