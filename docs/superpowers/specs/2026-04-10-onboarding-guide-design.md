# In-App Onboarding Guide — Design Spec

## Mục tiêu

CEO xong wizard → mở Dashboard → biết ngay phải làm gì. Không cần đọc README, không cần Google, không cần gọi support.

## 3 tầng hướng dẫn

### Tầng 1: Getting Started Checklist (Overview page)

Hiện ngay trên trang Tổng quan, phía trên stats. Biến mất khi CEO hoàn thành tất cả bước.

```
┌──────────────────────────────────────────────────┐
│ Bắt đầu sử dụng MODOROClaw                      │
│                                                  │
│ [x] Cài đặt xong                    ✓           │
│ [ ] Gửi tin test Telegram            → Thử ngay  │
│ [ ] Upload 1 tài liệu Knowledge     → Mở        │
│ [ ] Kiểm tra Zalo kết nối           → Kiểm tra  │
│ [ ] Ra lệnh bot đầu tiên            → Hướng dẫn │
│                                                  │
│ 1/5 hoàn thành              [Bỏ qua checklist]  │
└──────────────────────────────────────────────────┘
```

**5 bước:**

| # | Bước | Auto-detect hoàn thành | CTA |
|---|------|----------------------|-----|
| 1 | Cài đặt xong | Luôn true (đã qua wizard) | — |
| 2 | Gửi tin test Telegram | Detect: audit.jsonl có `telegram_test_sent` event | Bấm → chuyển tab Telegram → highlight nút "Gửi tin test" |
| 3 | Upload 1 tài liệu Knowledge | Detect: bất kỳ file nào trong `knowledge/*/files/` | Bấm → chuyển tab Knowledge |
| 4 | Kiểm tra Zalo kết nối | Detect: Zalo ready probe = true | Bấm → chuyển tab Zalo |
| 5 | Ra lệnh bot đầu tiên | Detect: audit.jsonl có `gateway_ready` + ít nhất 1 conversation reply | Bấm → mở help popup với danh sách lệnh |

**Persist:** `localStorage.setItem('onboarding-checklist-dismissed', 'true')`. Nút "Bỏ qua" dismiss vĩnh viễn.

**Auto-check:** mỗi lần `loadOverview()` → check 5 conditions → update checklist. Tất cả 5 done → card tự biến mất.

### Tầng 2: Tab First-Visit Tour (popup guided)

Mỗi tab có 1 tour chạy LẦN ĐẦU mở tab. Popup nhỏ cạnh element, có mũi tên chỉ.

**Cách hoạt động:**
- User click tab → `switchPage('zalo')` → check `localStorage.getItem('tour-zalo-done')`
- Chưa done → start tour: hiện popup sequence (1 → 2 → 3 → Done)
- Mỗi popup: highlight element + text giải thích + nút "Tiếp" / "Bỏ qua"
- Xong → `localStorage.setItem('tour-zalo-done', 'true')`

**Tour content per tab:**

#### Tab Tổng quan (2 steps)
1. Chỉ vào stat cards: "Đây là tổng quan hoạt động hôm nay — khách mới, sự kiện, cron đã chạy"
2. Chỉ vào "Cần xử lý": "Những việc cần anh/chị xử lý sẽ hiện ở đây"

#### Tab Lịch tự động (2 steps)
1. Chỉ vào schedule list: "Bot tự động chạy các tác vụ này theo lịch. Bấm vào để xem chi tiết."
2. Chỉ vào toggle: "Bật/tắt từng lịch tại đây. Bot cũng tạo lịch mới khi anh/chị yêu cầu qua Telegram."

#### Tab Telegram (3 steps)
1. Chỉ vào connection status: "Trạng thái kết nối Telegram. Xanh = sẵn sàng nhận tin."
2. Chỉ vào "Gửi tin test": "Bấm để bot gửi 1 tin thử vào Telegram của anh/chị."
3. Chỉ vào lệnh list: "12 lệnh có sẵn. Gõ /menu trong Telegram để xem."

#### Tab Zalo (3 steps)
1. Chỉ vào connection status: "Trạng thái Zalo. Xanh = bot đang nhận tin từ khách."
2. Chỉ vào "Chọn chủ Zalo": "Chọn tài khoản Zalo cá nhân để bot nhận diện anh/chị là chủ."
3. Chỉ vào nhóm list: "Tick nhóm nào bot được phép trả lời khi @mention."

#### Tab Knowledge (2 steps)
1. Chỉ vào folder list: "Upload tài liệu vào đây — SOP, bảng giá, catalog. Bot tự đọc và dùng khi khách hỏi."
2. Chỉ vào upload zone: "Kéo thả file hoặc bấm để chọn. Hỗ trợ PDF, Word, Excel, TXT."

#### Tab 9Router (1 step)
1. "Quản lý AI provider và model. Mật khẩu mặc định: 123456. Thường không cần thay đổi gì."

#### Tab OpenClaw (1 step)
1. "Xem log bot real-time. Dùng để debug khi bot trả lời sai."

### Tầng 3: Built-in Help Page (help.html)

Mỗi tab có nút "?" hoặc "Hướng dẫn" ở header → mở help page tương ứng.

**File:** `electron/ui/help.html` — single HTML page với sidebar navigation.

**Sections:**

1. **Bắt đầu**
   - MODOROClaw là gì
   - Kiến trúc tổng quan (đơn giản, không technical)
   - Cách bot hoạt động

2. **Telegram**
   - 12 lệnh và ý nghĩa
   - Cách ra lệnh bot (ví dụ thực tế)
   - Escalation từ Zalo hiện như thế nào
   - Báo cáo sáng/tối đọc ra sao

3. **Zalo**
   - Bot trả lời khách như thế nào
   - Chọn chủ Zalo
   - Quản lý nhóm (allowlist)
   - Blocklist
   - /pause khi nhân viên take over
   - 3 chế độ: auto / read / daily

4. **Knowledge**
   - Upload file gì
   - Bot dùng knowledge ra sao
   - Tạo folder mới
   - Tips: upload FAQ, bảng giá, SOP → bot thông minh hơn

5. **Lịch tự động**
   - 8 lịch mặc định
   - Cách tạo lịch mới qua Telegram
   - Đổi giờ
   - Test lịch

6. **Bảo mật**
   - Dashboard PIN
   - Output filter
   - Ai có quyền gì

7. **Xử lý sự cố**
   - Bot không trả lời → check gì
   - Zalo disconnect → quét QR lại
   - Telegram test fail → check token
   - Gateway restart → đợi 30s

**Mỗi section:** tiếng Việt, ngắn gọn, có ảnh/screenshot nếu cần, ví dụ thực tế.

**Mở help:** `mainWindow.loadFile('ui/help.html')` trong new BrowserWindow hoặc tab mới.

## UI Components

### Checklist Card (Overview)
```css
.onboarding-checklist {
  background: linear-gradient(135deg, var(--surface) 0%, var(--bg) 100%);
  border: 1px solid var(--accent);
  border-radius: 14px;
  padding: 20px;
  margin-bottom: 16px;
}
.onboarding-step {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 0; border-bottom: 1px solid var(--border);
}
.onboarding-step.done { opacity: 0.5; text-decoration: line-through; }
.onboarding-cta { margin-left: auto; font-size: 12px; cursor: pointer; color: var(--accent); }
```

### Tour Popup
```css
.tour-popup {
  position: fixed;
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 12px;
  padding: 16px;
  max-width: 300px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.2);
  z-index: 1000;
}
.tour-popup::after { /* arrow pointing to element */ }
.tour-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 999;
}
.tour-highlight {
  position: relative; z-index: 1001;
  box-shadow: 0 0 0 4px var(--accent);
  border-radius: 8px;
}
```

### Help Button (per-tab header)
```html
<button class="btn btn-secondary btn-small" onclick="openHelp('telegram')">
  <span data-icon="help-circle" data-icon-size="14"></span> Hướng dẫn
</button>
```

## Implementation

### Files:
```
electron/ui/
├── dashboard.html    ← Add: checklist, tour JS, help button per tab
├── help.html         ← NEW: full help page with sidebar nav
└── styles.css        ← Add: checklist + tour CSS
```

### Backend (main.js):
```javascript
// IPC: check onboarding progress
ipcMain.handle('get-onboarding-status', async () => {
  return {
    wizardDone: true,
    telegramTested: checkAuditEvent('telegram_test_sent'),
    knowledgeUploaded: checkKnowledgeHasFiles(),
    zaloConnected: await probeZaloReady(),
    firstReply: checkAuditEvent('gateway_ready'),
  };
});
```

### Phases:
| Phase | What | Effort |
|---|---|---|
| 1 | Checklist on Overview + auto-detect | 2h |
| 2 | Tour popups for 7 tabs | 3h |
| 3 | help.html full documentation | 3h |

Total: ~8h (1 full session)

## Success Criteria

- CEO xong wizard → thấy checklist → biết phải test Telegram, upload Knowledge, check Zalo
- CEO mở tab mới → tour 2-3 bước → hiểu tab làm gì
- CEO bấm "Hướng dẫn" bất kỳ tab → help page mở đúng section
- CEO không bao giờ phải Google "MODOROClaw cách dùng"
