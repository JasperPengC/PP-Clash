#!/usr/bin/env bash
# 生成 src-tauri/resources/kernel.zip（mihomo + GeoIP/GeoSite）。
#
# 优先从本机已有的 mihomo 拷贝并打包；后续可以改成从镜像下载 + 校验。
set -euo pipefail
cd "$(dirname "$0")/.."

KERNEL_CANDIDATES=(
  "$HOME/Library/Application Support/PPClash/bin/mihomo"
  "$(command -v mihomo || true)"
)

KERNEL=""
for c in "${KERNEL_CANDIDATES[@]}"; do
  [ -n "$c" ] && [ -f "$c" ] && KERNEL="$c" && break
done
if [ -z "$KERNEL" ]; then
  echo "找不到 mihomo 内核二进制，请先安装或把内核放到 ~/Library/Application Support/PPClash/bin/mihomo" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cp "$KERNEL" "$TMP/bin/mihomo"
chmod 755 "$TMP/bin/mihomo"
"$KERNEL" -v > "$TMP/version.txt" 2>&1

DATA="$HOME/Library/Application Support/PPClash"
for f in geosite.dat geoip.metadb geoip.dat country.mmdb ASN.mmdb; do
  if [ -f "$DATA/$f" ]; then
    cp "$DATA/$f" "$TMP/$f"
  fi
done

mkdir -p src-tauri/resources
rm -f src-tauri/resources/kernel.zip
(cd "$TMP" && zip -9 -q -r "$OLDPWD/src-tauri/resources/kernel.zip" bin version.txt geosite.dat geoip.metadb geoip.dat country.mmdb ASN.mmdb)
echo "已生成 src-tauri/resources/kernel.zip（内核：$(head -1 "$TMP/version.txt")）"
