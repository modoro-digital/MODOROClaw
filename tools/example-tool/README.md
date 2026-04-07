# Mẫu Công Cụ

Đây là template để tạo công cụ mới cho trợ lý.

## Cấu trúc

```
tools/example-tool/
├── README.md          # File này — công cụ làm gì
├── example-tool.js    # Code chính
├── package.json       # Dependencies (nếu dùng Node)
└── config.json        # Cấu hình (tuỳ chọn)
```

## Tạo công cụ mới

1. **Sao chép thư mục này**: `cp -r tools/example-tool tools/cong-cu-moi`
2. **Đổi tên file**: Cập nhật `example-tool.js` thành tên công cụ của bạn
3. **Cập nhật README.md**: Mô tả công cụ làm gì
4. **Triển khai**: Viết logic công cụ
5. **Kiểm tra**: Chạy thử thủ công để xác minh
6. **Tích hợp**: Tham chiếu từ AGENTS.md hoặc skills

## Hướng dẫn công cụ

- **Mục đích đơn**: Mỗi công cụ nên làm tốt một việc
- **Thân thiện CLI**: Hỗ trợ sử dụng dòng lệnh
- **Có tài liệu**: README rõ ràng kèm ví dụ
- **Đảo ngược được**: Ưu tiên hành động có thể hoàn tác
- **An toàn**: Không để lộ secret hoặc credential

## Ví dụ sử dụng

```bash
# Chạy trực tiếp
node tools/example-tool/example-tool.js --option value

# Tham chiếu từ AGENTS.md
node tools/cong-cu-moi/cong-cu-moi.js "dữ liệu đầu vào"
```

## Tích hợp với AGENTS.md

Thêm vào AGENTS.md:

```markdown
## Công Cụ Của Tôi
**Công cụ:** `tools/cong-cu-moi/cong-cu-moi.js`
**Mục đích:** Mô tả ngắn
**Sử dụng:** `node tools/cong-cu-moi/cong-cu-moi.js [tham số]`
```

Điều này giúp trợ lý phát hiện và sử dụng công cụ.
