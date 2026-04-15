#!/bin/bash
# 9BizClaw — Gỡ chặn Gatekeeper (chạy 1 lần sau khi kéo vào Applications)
echo ""
echo "=== 9BizClaw — Gỡ chặn Gatekeeper ==="
echo ""

APP_PATH="/Applications/9BizClaw.app"

if [ ! -d "$APP_PATH" ]; then
  echo "Chua tim thay $APP_PATH"
  echo "Hay keo 9BizClaw.app vao thu muc Applications truoc, roi chay lai file nay."
  echo ""
  read -p "Nhan Enter de dong..." _
  exit 1
fi

echo "Dang go chan Gatekeeper cho 9BizClaw..."
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null

echo "Xong! Dang mo 9BizClaw..."
echo ""
open "$APP_PATH"
exit 0
