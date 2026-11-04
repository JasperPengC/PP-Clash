#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo '--- observer ---'
if [ -f observability/observer.pid ] && kill -0 "$(cat observability/observer.pid)" 2>/dev/null; then
  echo "running pid=$(cat observability/observer.pid)"
else
  echo 'not running'
fi
echo '--- latest ---'
cat observability/status.txt 2>/dev/null || echo 'no samples yet'
echo '--- recent alerts/tail ---'
tail -3 observability/metrics.jsonl 2>/dev/null || true
