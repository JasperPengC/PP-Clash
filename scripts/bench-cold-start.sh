#!/usr/bin/env bash
# 冷启动基线：open 到主进程出现、主窗口可被 System Events 看到。
# 需要终端有「辅助功能」权限；没有权限时 win=timeout，但 pid 耗时仍有效。
set -euo pipefail
APP_NAME="${APP_NAME:-PP Clash}"
BUNDLE_BIN="${BUNDLE_BIN:-PP Clash.app/Contents/MacOS/ppclash}"
RUNS="${RUNS:-3}"
TIMEOUT_MS="${TIMEOUT_MS:-15000}"
cd "$(dirname "$0")/.."

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
quit_app() {
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 50); do
    pgrep -f "$BUNDLE_BIN" >/dev/null || return 0
    sleep 0.1
  done
}

for i in $(seq 1 "$RUNS"); do
  quit_app
  sleep 0.5
  start=$(now_ms)
  open -a "$APP_NAME"
  pid_ms="timeout"
  win_ms="timeout"
  while [ $(( $(now_ms) - start )) -lt "$TIMEOUT_MS" ]; do
    if pgrep -f "$BUNDLE_BIN" >/dev/null; then
      pid_ms=$(( $(now_ms) - start ))
      break
    fi
    sleep 0.02
  done
  if [ "$pid_ms" != "timeout" ]; then
    while [ $(( $(now_ms) - start )) -lt "$TIMEOUT_MS" ]; do
      count=$(osascript -e "tell application \"System Events\" to tell process \"$APP_NAME\" to count windows" 2>/dev/null || echo 0)
      if [ "${count:-0}" != "0" ]; then
        win_ms=$(( $(now_ms) - start ))
        break
      fi
      sleep 0.05
    done
  fi
  echo "run $i: pid=${pid_ms}ms window=${win_ms}ms"
done
quit_app
