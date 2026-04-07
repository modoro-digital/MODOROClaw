#!/bin/bash
# ============================================
#  MODOROClaw — Setup trên OpenClaw
#  Chạy sau khi đã cài OpenClaw
# ============================================

set -e

echo ""
echo "  🦞 MODOROClaw — Thiết Lập"
echo "  =========================="
echo ""

# Check OpenClaw
if ! command -v openclaw &> /dev/null; then
    echo "❌ Cần cài OpenClaw trước"
    echo "   https://docs.openclaw.ai/getting-started"
    exit 1
fi
echo "✅ OpenClaw — OK"

# Collect info
read -p "👤 Họ tên CEO: " CEO_NAME
read -p "🏢 Tên công ty: " COMPANY

echo ""
echo "--- Telegram ---"
read -p "🤖 Telegram Bot Token: " TG_TOKEN
read -p "🆔 Telegram User ID: " TG_USER_ID

echo ""
echo "--- Zalo ---"
read -p "🔑 Zalo Bot Token: " ZALO_TOKEN

echo ""
read -p "⏰ Giờ báo cáo sáng (0-23) [7]: " BRIEF_HOUR
BRIEF_HOUR="${BRIEF_HOUR:-7}"

# Configure channels
echo ""
echo "⚙️  Đang cấu hình..."

openclaw config set channels.telegram.botToken "$TG_TOKEN"
openclaw config set channels.telegram.dmPolicy "allowlist"
openclaw config set channels.telegram.allowFrom "[$TG_USER_ID]"
openclaw config set channels.zalo.botToken "$ZALO_TOKEN"
openclaw config set channels.zalo.dmPolicy "open"
echo "✅ Channels — OK"

# Install plugin
echo ""
echo "🔌 Cài plugin MODOROClaw..."
openclaw plugins install ./modoro-claw-plugin 2>/dev/null || echo "⚠️  Plugin cài thủ công sau"
echo "✅ Plugin — OK"

# Setup cron: morning briefing
echo ""
echo "⏰ Thiết lập báo cáo sáng..."
openclaw cron add \
  --name "morning-briefing" \
  --cron "0 $BRIEF_HOUR * * *" \
  --tz "Asia/Ho_Chi_Minh" \
  --session isolated \
  --message "Tạo báo cáo sáng cho $CEO_NAME ($COMPANY). Bao gồm: 1) Tin tức Việt Nam quan trọng hôm nay 2) Thời tiết 3) Tóm tắt tin nhắn Zalo qua đêm nếu có. Viết ngắn gọn, chuyên nghiệp." \
  --announce \
  --channel telegram
echo "✅ Báo cáo sáng — $BRIEF_HOUR:00 mỗi ngày"

# Setup cron: heartbeat check
openclaw cron add \
  --name "system-health" \
  --cron "0 */12 * * *" \
  --tz "Asia/Ho_Chi_Minh" \
  --session isolated \
  --message "Kiểm tra sức khỏe hệ thống. Báo cáo ngắn gọn: channels nào đang hoạt động, có lỗi gì không." \
  --announce \
  --channel telegram
echo "✅ Health check — mỗi 12 giờ"

echo ""
echo "============================================"
echo "  🎉 THIẾT LẬP HOÀN TẤT!"
echo "============================================"
echo ""
echo "  👤 $CEO_NAME ($COMPANY)"
echo "  📱 Telegram: ID $TG_USER_ID"
echo "  💬 Zalo: Đã kết nối"
echo "  ⏰ Báo cáo sáng: ${BRIEF_HOUR}:00"
echo ""
echo "  Khởi động: openclaw up"
echo "  Kiểm tra:  openclaw channels status --probe"
echo ""
