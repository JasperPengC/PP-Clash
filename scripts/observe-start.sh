#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p observability
if [ -f observability/observer.pid ]; then
  PID=$(cat observability/observer.pid)
  if kill -0 "$PID" 2>/dev/null; then
    echo "observer already running: $PID"
    exit 0
  fi
fi
nohup /usr/bin/python3 scripts/observe.py >>observability/observer.out 2>&1 &
echo $! > observability/observer.pid
sleep 1
cat observability/observer.pid
