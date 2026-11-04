#!/usr/bin/env bash
# 核心路径运行时冒烟：验证当前运行的 PP Clash 内核、控制端口、混合代理、配置与诊断日志。
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${PPCLASH_DATA_DIR:-$HOME/Library/Application Support/PPClash}"
STATE="$DATA/state.json"
PASS=0
FAIL=0

ok() { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

json() { /usr/bin/python3 -c "import json,sys; d=json.load(open('$STATE')); print(eval(sys.argv[1]))" "$1" 2>/dev/null || true; }

echo "== app/kernel =="
pgrep -f 'PP Clash.app/Contents/MacOS/ppclash' >/dev/null && ok "app process" || bad "app process"
pgrep -f '/PPClash/bin/mihomo' >/dev/null && ok "kernel process" || bad "kernel process"

MIXED=$(json "d['settings']['mixedPort']")
CTRL=$(json "d['settings']['controllerPort']")
DNS=$(json "d['settings']['dnsPort']")

echo "== ports =="
for spec in "mixed:$MIXED" "controller:$CTRL" "dns:$DNS"; do
  name=${spec%%:*}; port=${spec##*:}
  if /usr/bin/python3 - "$port" <<'PY'
import socket,sys
s=socket.socket(); s.settimeout(.5)
ok=s.connect_ex(('127.0.0.1',int(sys.argv[1])))==0
s.close(); sys.exit(0 if ok else 1)
PY
  then ok "$name port $port"; else bad "$name port $port"; fi
done

echo "== controller =="
VERSION=$(curl -sS --max-time 4 "http://127.0.0.1:$CTRL/version" 2>/dev/null || true)
[ -n "$VERSION" ] && ok "controller /version" || bad "controller /version"

echo "== proxy =="
CODE=$(curl -sS -x "http://127.0.0.1:$MIXED" --max-time 8 -o /dev/null -w '%{http_code}' https://www.google.com/generate_204 || true)
[ "$CODE" = "204" ] && ok "mixed proxy google 204" || bad "mixed proxy google ($CODE)"

echo "== config =="
BIN="/Library/Application Support/PPClash/bin/mihomo"
[ -x "$BIN" ] && ok "kernel binary" || bad "kernel binary"
if [ -f "$DATA/config.yaml" ] && [ -x "$BIN" ]; then
  if "$BIN" -t -d "$DATA" -f "$DATA/config.yaml" >/tmp/ppclash-e2e-config.log 2>&1; then
    ok "mihomo -t config"
  else
    bad "mihomo -t config"
    tail -5 /tmp/ppclash-e2e-config.log
  fi
fi

echo "== diagnostics =="
[ -f "$DATA/app.log" ] && ok "app.log" || bad "app.log"
[ -f "$DATA/kernel.log" ] && ok "kernel.log" || bad "kernel.log"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
