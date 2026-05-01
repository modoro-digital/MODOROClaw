# Kế Hoạch Test Media Library + Image Knowledge

## Mục tiêu

Tài liệu này dùng để test luồng:

- lưu trữ tài sản hình ảnh trong app
- mô tả ảnh bằng vision
- index ảnh/PDF scan vào knowledge
- tìm đúng ảnh theo ngôn ngữ tự nhiên
- gửi ảnh sản phẩm thật qua Zalo
- dùng brand asset để tạo ảnh AI

Mục tiêu cuối cùng là xác nhận app không chỉ "upload file", mà thật sự:

- hiểu ảnh
- tìm được ảnh
- phân biệt asset nội bộ và asset được phép gửi khách
- tận dụng asset đúng chỗ trong bot flow

## Phạm vi cần pass

Một bản test đạt yêu cầu khi:

- brand asset upload được, hiển thị được, không bị lẫn với product asset
- product image search được bằng mô tả tự nhiên
- PDF có text đọc được qua knowledge
- PDF scan vẫn search được sau khi vision xử lý
- bot Zalo gửi được ảnh sản phẩm thật cho người test
- luồng tạo ảnh AI lấy được logo hoặc mascot từ Media Library

## Chuẩn bị dữ liệu test

Chuẩn bị tối thiểu các file sau:

1. `logo-9bizclaw.png`
   - dùng để test nhóm `brand`

2. `product-black.jpg`
   - ảnh sản phẩm có màu nổi bật, ví dụ màu đen

3. `product-red.jpg`
   - ảnh sản phẩm thứ hai để kiểm tra search không bị lẫn

4. `poster-text.jpg`
   - ảnh có chữ rõ, để test vision mô tả

5. `catalog-text.pdf`
   - PDF có text thật, copy được text khi mở bằng trình đọc PDF

6. `catalog-scan.pdf`
   - PDF scan từ ảnh hoặc ảnh chụp, không copy text trực tiếp được

7. 1 tài khoản Zalo test hoặc group test
   - dùng để xác nhận bot gửi ảnh thật

## Quy tắc test

- Test theo đúng thứ tự từng vòng, không nhảy cóc.
- Nếu fail, ghi lại đúng input, output, và bước fail.
- Không kết luận "bot không làm được" nếu mới test 1 prompt mơ hồ.
- Với PDF scan, phải chờ xử lý xong rồi mới search.

## Vòng 1: UI và lưu asset

### Bước test

1. Mở app.
2. Vào tab `Tài sản hình ảnh`.
3. Upload `logo-9bizclaw.png` vào nhóm brand.
4. Upload `product-black.jpg` và `product-red.jpg` vào nhóm product.
5. Upload `poster-text.jpg`.

### Kỳ vọng

- file xuất hiện trong đúng khu vực
- có preview hoặc item card hiển thị ổn
- không bị treo app
- không tràn text, không vỡ layout
- mở lại app vẫn thấy asset còn trong danh sách

### Fail phổ biến cần để ý

- upload xong nhưng không hiện item
- hiện item nhưng sai nhóm
- item hiện nhưng preview lỗi
- app đứng lâu không báo trạng thái

## Vòng 2: Vision và search ảnh

### Bước test

1. Sau khi upload xong, chờ hệ thống xử lý mô tả.
2. Tìm bằng các từ khóa tự nhiên.

### Query mẫu

- `màu đen`
- `logo`
- `ảnh có chữ`
- `sản phẩm màu đỏ`
- `hộp sản phẩm`

### Kỳ vọng

- kết quả ra đúng asset dù không gõ tên file chính xác
- asset sản phẩm dễ tìm bằng mô tả tự nhiên
- brand asset không bị lẫn sang luồng customer search nếu không được phép

### Fail phổ biến cần để ý

- chỉ search được theo tên file, không search được theo nội dung ảnh
- search ra sai asset
- search không phân biệt visibility

## Vòng 3: Knowledge với PDF

### Case A: PDF có text thật

#### Bước test

1. Upload `catalog-text.pdf` vào knowledge hoặc vùng xử lý tài liệu có liên quan.
2. Đợi index xong.
3. Search một câu ngắn chắc chắn có trong file.

#### Kỳ vọng

- file được index
- search ra nội dung nhanh
- kết quả phù hợp với text thực trong PDF

### Case B: PDF scan

#### Bước test

1. Upload `catalog-scan.pdf`.
2. Chờ hệ thống xử lý xong toàn bộ trang.
3. Search theo nội dung nhìn thấy trên từng trang.

#### Query mẫu

- `bảo hành 12 tháng`
- `thông số kỹ thuật`
- `mẫu màu đen`
- `giá niêm yết`

#### Kỳ vọng

- PDF scan vẫn có thể search được sau khi vision chạy xong
- nội dung không cần khớp 100 phần trăm câu chữ, nhưng phải đủ gần để ra đúng trang hoặc đúng tài liệu
- tài liệu nhiều trang vẫn có khả năng tìm theo từng phần nội dung

### Fail phổ biến cần để ý

- PDF text thật cũng bị đẩy qua scan path quá chậm
- PDF scan báo xong nhưng search không ra gì
- search chỉ ra file chung chung, không đủ liên quan

## Vòng 4: End-to-end với bot

### Case A: Bot gửi ảnh sản phẩm thật qua Zalo

#### Bước test

1. Đảm bảo `product-black.jpg` và `product-red.jpg` là asset `public`.
2. Nhắn bot qua Zalo.

#### Prompt mẫu

- `Cho anh xem hình sản phẩm màu đen`
- `Gửi anh 1 ảnh sản phẩm màu đỏ`
- `Có hình mẫu này không`

#### Kỳ vọng

- bot tìm được asset phù hợp
- bot gửi ảnh thật, không chỉ trả lời text
- nếu có nhiều kết quả gần giống nhau, bot hỏi lại ngắn gọn

### Case B: Tạo ảnh AI từ brand asset

#### Bước test

1. Đảm bảo đã có `logo-9bizclaw.png` hoặc mascot trong nhóm brand.
2. Gửi lệnh tạo ảnh trong app hoặc bot flow tương ứng.

#### Prompt mẫu

- `Dùng logo hiện có tạo 1 ảnh quảng cáo vuông cho 9BizClaw`
- `Tạo 1 poster công nghệ, giữ nguyên logo thương hiệu`

#### Kỳ vọng

- job tạo ảnh chạy được
- hệ thống lấy asset từ Media Library
- brand asset được dùng để tạo ảnh, nhưng không bị bot gửi trực tiếp cho khách như ảnh sản phẩm

## Bộ test nhanh 10 phút

Nếu cần test nhanh sau mỗi build, chạy đúng 6 bước này:

1. Upload 1 logo brand.
2. Upload 2 ảnh sản phẩm.
3. Upload 1 PDF scan.
4. Search 3 lần bằng từ tự nhiên.
5. Nhắn bot xin 1 ảnh sản phẩm.
6. Tạo 1 ảnh quảng cáo từ logo.

Nếu qua cả 6 bước này thì media pipeline cơ bản đang sống.

## Mẫu ghi bug

Ghi bug theo format này:

```text
Tiêu đề:

Môi trường:
- App version:
- Windows version:

Bước tái hiện:
1.
2.
3.

Input:

Kết quả thực tế:

Kết quả mong đợi:

Mức độ:
- Chặn test / Nghiêm trọng / Vừa / Nhẹ
```

## Ví dụ bug report tốt

```text
Tiêu đề:
Upload PDF scan xong nhưng search không ra nội dung

Môi trường:
- App version: 2.4.0
- Windows version: 11

Bước tái hiện:
1. Upload file catalog-scan.pdf
2. Chờ trạng thái xử lý xong
3. Search từ khóa "bảo hành 12 tháng"

Input:
catalog-scan.pdf

Kết quả thực tế:
Không có kết quả nào phù hợp

Kết quả mong đợi:
Ra đúng tài liệu hoặc ít nhất ra 1 hit liên quan đến trang có nội dung bảo hành

Mức độ:
Nghiêm trọng
```

## Kết luận pass

Bản build có thể coi là pass cho hạng mục này khi:

- upload ảnh ổn định
- vision index hoạt động
- PDF scan có giá trị search thật
- Zalo gửi được ảnh thật
- image generation dùng đúng brand asset

Nếu thiếu 1 trong 5 ý trên thì chưa nên xem là hoàn thiện.
