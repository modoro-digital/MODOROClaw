# Shop State Format (shop-state.json)

> CEO cập nhật state này qua Dashboard → "Tình trạng hôm nay". Bot đọc file này mỗi turn để áp dụng context thời gian thực của shop.

## File path

`<workspace>/shop-state.json`

Trên Windows: `%APPDATA%/modoro-claw/shop-state.json`
Trên Mac: `~/Library/Application Support/modoro-claw/shop-state.json`

## Schema

```json
{
  "updatedAt": "2026-04-11T10:30:00+07:00",
  "updatedBy": "CEO via Dashboard",
  "outOfStock": ["Combo A - gà", "Size L áo thun basic"],
  "staffAbsent": ["Chị Hằng", "Anh Minh"],
  "shippingDelay": {
    "active": true,
    "reason": "mưa bão miền Bắc",
    "estimatedDelayHours": 2
  },
  "activePromotions": [
    {"name": "Sinh nhật shop", "description": "Giảm 15% đơn trên 500k", "validUntil": "2026-04-15"}
  ],
  "earlyClosing": {
    "active": false,
    "time": null
  },
  "specialNotes": "Hôm nay chỉ nhận đơn online, không nhận khách đến shop trực tiếp"
}
```

## Field semantics

### updatedAt: string (ISO 8601)
Timestamp cập nhật gần nhất. Dashboard tự ghi khi CEO bấm lưu.

### updatedBy: string
Nguồn update. Thường là `"CEO via Dashboard"` hoặc `"auto-reset cron"`.

### outOfStock: string[]
List tên sản phẩm đang hết hàng. Bot dùng khi khách hỏi SP cụ thể — cảnh báo trước khi khách đặt. VD: khách hỏi "combo A còn không" → bot check `outOfStock`, nếu có → "Dạ rất tiếc combo A hôm nay hết rồi ạ, em gợi ý combo B tương tự không ạ?"

### staffAbsent: string[]
Tên nhân viên nghỉ hôm nay. Nếu khách hỏi gặp nhân viên cụ thể → bot thông báo và đề nghị hỗ trợ thay.

### shippingDelay: object
- `active: boolean` — có đang delay không
- `reason: string` — lý do (mưa bão, lễ tết, quá tải đơn)
- `estimatedDelayHours: number` — ước tính số giờ trễ

Nếu `active=true`, bot sẽ:
- Báo preemptively khi khách đặt đơn
- Không confirm thời gian ship cụ thể
- Gợi ý khách chờ hoặc đến shop lấy trực tiếp

### activePromotions: object[]
Khuyến mãi đang chạy. Mỗi item gồm `name`, `description`, `validUntil` (YYYY-MM-DD).

Bot dùng khi khách hỏi "có giảm giá không" hoặc tự gợi ý khi phù hợp. Bot KHÔNG tự tạo promotion không có trong list này — chỉ quote y nguyên.

### earlyClosing: object
- `active: boolean`
- `time: string | null` — giờ đóng sớm dạng `"HH:MM"` (VD `"18:00"`)

Nếu `active=true` và khách nhắn sau giờ `time` → bot báo shop đã đóng sớm và hẹn khách mai.

### specialNotes: string
Free-form note. Bot đọc và áp dụng linh hoạt. Dùng cho các tình huống không rơi vào các field có structure sẵn.

## Bot usage rules

1. Đọc `shop-state.json` TRƯỚC khi reply nếu khách hỏi về:
   - Sản phẩm cụ thể → check `outOfStock`
   - Nhân viên cụ thể → check `staffAbsent`
   - Ship / vận chuyển → check `shippingDelay`
   - Khuyến mãi / giá → check `activePromotions`
   - Giờ mở cửa → check `earlyClosing`

2. Nếu không có file này → bot hoạt động bình thường, giả định không có state đặc biệt. KHÔNG fail.

3. File auto-reset mỗi ngày 00:00 (cron) — CEO phải cập nhật lại state cho hôm nay. `outOfStock`, `staffAbsent`, `shippingDelay.active`, `earlyClosing.active` reset về rỗng / false. `activePromotions` giữ nguyên (chỉ auto-remove item đã quá `validUntil`).

4. Bot không được tự ý ghi file này. Chỉ Dashboard và cron reset mới có quyền ghi.

## Dashboard UI

Dashboard tab "Tình trạng hôm nay" có toggles + inputs để CEO update 6 fields này không cần sửa JSON tay. Mỗi lần lưu → Dashboard ghi lại `updatedAt` và broadcast event để bot reload state ngay.

## Bot template khi dùng state

- Hết hàng: "Dạ rất tiếc hôm nay bên em hết [SP] rồi ạ, em gợi ý [alternative] được không ạ?"
- Nhân viên nghỉ: "Dạ hôm nay [nhân viên X] nghỉ ạ, em hỗ trợ anh/chị có được không ạ?"
- Ship delay: "Dạ hôm nay ship hơi chậm khoảng [N giờ] do [lý do] ạ, anh/chị thông cảm nhé."
- Khuyến mãi: "Dạ bên em đang có [khuyến mãi] đến [ngày] ạ, anh/chị tham khảo nhé."
- Đóng sớm: "Dạ hôm nay shop em đóng sớm lúc [giờ] ạ, mai em phục vụ anh/chị từ sáng nhé."
