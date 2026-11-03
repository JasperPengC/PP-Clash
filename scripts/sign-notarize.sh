#!/usr/bin/env bash
# 对 .app 做 Developer ID 签名与 Apple 公证。
#
# 没有证书/凭据时明确跳过，不伪造成功：
#   APPLE_SIGNING_IDENTITY  例如 "Developer ID Application: Name (TEAMID)"
#   APPLE_ID                 Apple ID
#   APPLE_TEAM_ID            Team ID
#   APPLE_APP_PASSWORD       App-specific password
# 用法：./scripts/sign-notarize.sh [APP_PATH]
set -euo pipefail
cd "$(dirname "$0")/.."

APP_PATH="${1:-src-tauri/target/release/bundle/macos/PPClash.app}"
[ -d "$APP_PATH" ] || { echo "找不到 $APP_PATH" >&2; exit 1; }

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  echo "⚠️  未设置 APPLE_SIGNING_IDENTITY，跳过签名/公证（当前 ad-hoc 签名）"
  exit 0
fi

echo "▸ 签名 $APP_PATH"
codesign --force --deep --options runtime --timestamp \
  --sign "$IDENTITY" "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ] || [ -z "${APPLE_APP_PASSWORD:-}" ]; then
  echo "⚠️  缺少 APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD，跳过公证"
  exit 0
fi

echo "▸ 公证"
ZIP="$(mktemp -d)/PP-Clash.zip"
ditto -c -k --keepParent "$APP_PATH" "$ZIP"
xcrun notarytool submit "$ZIP" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --wait
xcrun stapler staple "$APP_PATH"
spctl --assess --type execute --verbose "$APP_PATH"
echo "✅ 签名与公证完成"
