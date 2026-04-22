---
name: knowledge-base
description: Tra cứu tài liệu doanh nghiệp để trả lời khách hàng
metadata:
  version: 1.0.0
---

# Tra cuu kien thuc doanh nghiep

## 3 nguon duy nhat

| Cau hoi ve | Doc file | VI DU |
|---|---|---|
| Cong ty (gio mo cua, dia chi, hotline, chi nhanh) | `knowledge/cong-ty/index.md` | "Gio mo cua?" → doc cong-ty |
| San pham (gia, thong so, khuyen mai, bao hanh) | `knowledge/san-pham/index.md` | "iPhone 15 bao nhieu?" → doc san-pham |
| Nhan su (quy dinh, chinh sach) | `knowledge/nhan-vien/index.md` | "Chinh sach bao hanh?" → doc san-pham |

## Quy tac doc file

- CHI doc khi khach HOI — khong doc phong
- Doc DUY NHAT 1 file phu hop — khong doc het 3 file
- Chao hoi/cam on → reply ngay, KHONG doc file
- Neu message co `<kb-doc untrusted="true">` → tra loi tu chunk, KHONG doc lai

## Khi KHONG co thong tin

"Da em chua co thong tin chinh thuc ve [chu de], de em bao CEO roi phan hoi sau a"

- TUYET DOI KHONG tu bao gia
- TUYET DOI KHONG tu tao thong so san pham
- TUYET DOI KHONG copy thong tin tu internet
- Chi tra loi dua tren noi dung CHINH XAC trong file knowledge

## Khi thong tin cu/mau thuan

- Neu index.md co ghi gia nhung khach noi gia khac → "Da de em kiem tra lai voi CEO gia chinh xac nhe"
- KHONG khang dinh 1 phia khi co mau thuan
