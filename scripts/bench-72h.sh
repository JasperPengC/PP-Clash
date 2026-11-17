#!/usr/bin/env bash
# 72 小时稳定性采样：每小时记录一次内存/CPU/内核存活。
# 用法：
#   ./scripts/bench-72h.sh                 # 输出 observability/soak-<timestamp>.csv
#   HOURS=72 INTERVAL=3600 ./scripts/bench-72h.sh
set -euo pipefail
cd "$(dirname "$0")/.."

HOURS="${HOURS:-72}"
INTERVAL="${INTERVAL:-3600}"
OUT="${OUT:-observability/soak-$(date +%Y%m%d-%H%M%S).csv}"
mkdir -p "$(dirname "$OUT")"

if [ ! -f "$OUT" ]; then
  echo "timestamp,ppclash_rss_mb,mihomo_rss_mb,ppclash_pid,mihomo_pid,kernel_alive" > "$OUT"
fi

echo "开始 72h 采样：$OUT（${HOURS}h，每 ${INTERVAL}s）"
for i in $(seq 1 "$HOURS"); do
  APP_PID=$(pgrep -f 'PP Clash.app/Contents/MacOS/ppclash' | head -1 || true)
  KERNEL_PID=$(pgrep -f 'PPClash/bin/mihomo' | head -1 || true)
  APP_RSS=$( [ -n "$APP_PID" ] && ps -p "$APP_PID" -o rss= 2>/dev/null | awk '{printf "%.1f", $1/1024}' || echo "")
  KERNEL_RSS=$( [ -n "$KERNEL_PID" ] && ps -p "$KERNEL_PID" -o rss= 2>/dev/null | awk '{printf "%.1f", $1/1024}' || echo "")
  ALIVE=$( [ -n "$KERNEL_PID" ] && echo 1 || echo 0 )
  echo "$(date '+%Y-%m-%d %H:%M:%S'),${APP_RSS:-},${KERNEL_RSS:-},${APP_PID:-},${KERNEL_PID:-},$ALIVE" >> "$OUT"
  [ "$i" -lt "$HOURS" ] && sleep "$INTERVAL"
done
echo "完成：$OUT"
