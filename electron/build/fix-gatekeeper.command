#!/bin/bash
# 9BizClaw — Gỡ chặn Gatekeeper (chạy 1 lần sau khi kéo vào Applications)
echo ""
echo "=== 9BizClaw — Gỡ chặn Gatekeeper ==="
echo ""

APP_PATH="/Applications/9BizClaw.app"

if [ ! -d "$APP_PATH" ]; then
  echo "Chưa tìm thấy $APP_PATH"
  echo "Hãy kéo 9BizClaw.app vào thư mục Applications trước, rồi chạy lại file này."
  echo ""
  read -p "Nhấn Enter để đóng..." _
  exit 1
fi

echo "Đang gỡ chặn Gatekeeper cho 9BizClaw..."
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null

echo "Xong! Đang mở 9BizClaw..."
echo ""
open "$APP_PATH"
exit 0
