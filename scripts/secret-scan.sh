#!/usr/bin/env bash
# 公开仓库的轻量敏感信息扫描。
# 不是密钥检测的替代品，但能在 push 前挡住最常见的误提交。
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

sensitive_names='(^|/)(\.env($|\.)|.*\.(pem|key|p12|pfx|cer|crt|mobileprovision|keystore|jks|ovpn))$'
name_hits="$(git ls-files | grep -Ei "$sensitive_names" || true)"
if [ -n "$name_hits" ]; then
  echo "❌ 发现可能包含凭据的文件：" >&2
  echo "$name_hits" >&2
  fail=1
fi

patterns='ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
content_hits="$(git grep -nE "$patterns" -- . 2>/dev/null || true)"
if [ -n "$content_hits" ]; then
  echo "❌ 发现疑似密钥 / 私钥：" >&2
  echo "$content_hits" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "扫描未通过：请移除敏感信息后再提交。" >&2
  exit 1
fi
echo "✅ 敏感信息扫描通过"
