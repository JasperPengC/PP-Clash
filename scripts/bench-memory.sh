#!/usr/bin/env bash
# 内存基线：PP Clash 主进程 + mihomo 内核的 RSS。
#
# WebKit 的 WebContent / GPU / Networking 由 launchd 托管，命令行里不带宿主 App
# 标识，无法可靠地从 ps 归属；请在活动监视器里按「PP Clash」过滤查看辅助进程。
set -euo pipefail
printf '%-22s %10s %s\n' "PROCESS" "RSS(MB)" "PID"
total=0

row() {
  local name="$1" pid="$2"
  if [ -z "$pid" ]; then
    printf '%-22s %10s %s\n' "$name" "-" "-"
    return
  fi
  local rss
  rss=$(ps -p "$pid" -o rss= 2>/dev/null | tr -d ' ' || true)
  if [ -z "$rss" ]; then
    printf '%-22s %10s %s\n' "$name" "-" "$pid"
    return
  fi
  local mb
  mb=$(python3 -c "print(f'{$rss/1024:.1f}')")
  total=$(python3 -c "print($total + $rss/1024)")
  printf '%-22s %10s %s\n' "$name" "$mb" "$pid"
}

APP_PID=$(pgrep -f 'PP Clash.app/Contents/MacOS/ppclash' | head -1 || true)
KERNEL_PID=$(pgrep -f 'PPClash/bin/mihomo' | head -1 || true)
row "PP Clash" "$APP_PID"
row "mihomo" "$KERNEL_PID"

printf '%-22s %10.1f\n' "TOTAL (app+kernel)" "$total"
echo
echo "辅助进程请在活动监视器按「PP Clash」过滤；WebKit 由 launchd 托管，ps 无法归属。"
