# Công Cụ Bộ Nhớ Database

Hệ thống bộ nhớ nhẹ dựa trên SQLite với tìm kiếm toàn văn để truy xuất bộ nhớ nhanh và chính xác.

## Cài đặt

```bash
npm install
node rebuild-db.js  # Xây dựng lần đầu
```

## Sử dụng

```bash
# Tìm kiếm bộ nhớ liên quan
node relevant-memory.js "truy vấn về công việc trước đó"

# Xây lại sau khi chỉnh sửa bộ nhớ đáng kể
node rebuild-db.js
```

## Cách hoạt động

1. Quét tất cả file markdown trong workspace
2. Trích xuất nội dung và metadata
3. Xây dựng cơ sở dữ liệu SQLite với FTS5 (tìm kiếm toàn văn)
4. Cung cấp tìm kiếm tương tự ngữ nghĩa qua so sánh văn bản

## File

- `relevant-memory.js` — Tiện ích tìm kiếm
- `rebuild-db.js` — Xây dựng database
- `memory.db` — Cơ sở dữ liệu SQLite (tự tạo)

## Tại sao SQLite + FTS5?

- Không phụ thuộc bên ngoài
- Đủ nhanh cho hầu hết trường hợp
- Không tốn phí API
- Hoạt động offline
- Di động (một file duy nhất)

## Khi nào dùng

Dùng khi cần tìm ngữ cảnh liên quan nhanh chóng mà không cần trả phí cho vector embeddings. Với hầu hết trường hợp trợ lý cá nhân, tìm kiếm FTS5 là "đủ tốt."

## Tích hợp

AGENTS.md khuyên dùng tool này trước khi đi sâu vào file markdown:

```bash
node tools/memory-db/relevant-memory.js "dự án chuyển đổi"
# Sau đó đọc file cụ thể mà nó gợi ý
```
