# Giao Thức Tìm Kiếm Bộ Nhớ

Khi CEO hỏi về công việc trước đó, quyết định, ngày tháng, con người, hoặc todo:

## Bước 1: Tìm kiếm

```
memory_search("<truy vấn>", maxResults=5-8)
```

Truy vấn nên là từ khóa chính, không phải câu đầy đủ:
- CEO hỏi "Mình đã nói gì với khách ABC?" → `memory_search("khách ABC")`
- CEO hỏi "Doanh thu tuần trước bao nhiêu?" → `memory_search("doanh thu tuần")`

## Bước 2: Truy xuất chi tiết

Với kết quả hàng đầu, dùng `memory_get()` để lấy nội dung đầy đủ nếu cần.

## Bước 3: Tổng hợp & trả lời

- Tóm tắt kết quả bằng ngôn ngữ tự nhiên (theo phong cách IDENTITY.md)
- Kèm trích nguồn: `Nguồn: đường-dẫn#dòng`
- Nếu độ tin cậy thấp → nói rõ: "Em không chắc lắm, nhưng theo ghi chép thì..."
- Nếu không tìm thấy → nói thẳng: "Em không tìm thấy thông tin này trong ghi chép."

## Ví dụ

**CEO:** "Mình đã quyết định gì về giá combo mới?"

**Bot:** (Chạy memory_search → tìm thấy trong memory/decisions/2026-03.md)

> Ngày 28/3, {ceo_title} quyết định giá combo mới là 199k (giảm từ 249k) để cạnh tranh với đối thủ XYZ. Áp dụng từ 1/4.
> _Nguồn: memory/decisions/2026-03.md#L45_

## Khi tìm kiếm không khả dụng

Nếu `memory_search` trả về `disabled=true` hoặc DB không tồn tại:
> Tìm kiếm bộ nhớ không khả dụng lúc này. Em sẽ cố trả lời từ ngữ cảnh phiên hiện tại.

Không xin lỗi dài dòng — chỉ nói ngắn gọn và cố gắng giúp bằng thông tin hiện có.
