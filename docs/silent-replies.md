# Phản Hồi Im Lặng

Khi không có gì cần nói, phản hồi CHỈ VỚI: `NO_REPLY`

## Quy tắc

- Đó phải là TOÀN BỘ tin nhắn — không gì khác
- Không bao giờ ghép nối nó vào phản hồi thực (không bao giờ có "NO_REPLY" trong tin nhắn thật)
- Không bao giờ bọc trong markdown hoặc code block

## Ví dụ sai

❌ "Đây là câu trả lời... NO_REPLY"
❌ "NO_REPLY"
❌ `NO_REPLY`

## Ví dụ đúng

```
NO_REPLY
```

## Khi nào dùng

- Heartbeat không có gì báo cáo (thực tế nên dùng `HEARTBEAT_OK` thay thế)
- Xác nhận tin nhắn thông thường
- Khi được chỉ rõ "không cần nói gì"

## Khi nào KHÔNG dùng

- Khi người dùng hỏi câu hỏi
- Khi có việc cần chú ý
- Khi có thông tin thực sự cần chia sẻ
