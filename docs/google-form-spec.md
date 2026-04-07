# Google Form — "MODOROClaw — Dang ky cai dat tro ly AI"

Tao form nay tren Google Forms. Team MODORO dung de thu thap thong tin khach hang da mua, len lich remote cai dat qua TeamViewer (1-2 tieng).

---

## Fields

### 1. Ho ten
- Loai: Short text
- Bat buoc: Yes

### 2. Ten cong ty
- Loai: Short text
- Bat buoc: Yes

### 3. So dien thoai / Zalo
- Loai: Short text
- Bat buoc: Yes
- Validation: so dien thoai

### 4. Telegram (username hoac so dien thoai)
- Loai: Short text
- Bat buoc: Yes
- Ghi chu: "De gui bot link truoc ngay cai. Vi du: @username hoac 0901234567"

### 5. Email cong ty
- Loai: Email
- Bat buoc: Yes

### 6. Website cong ty (neu co)
- Loai: URL
- Bat buoc: No

### 7. Linh vuc
- Loai: Dropdown
- Bat buoc: Yes
- Options:
  - Bat dong san
  - F&B / Nha hang / Quan ca phe
  - Thuong mai / Ban le
  - Dich vu (spa, salon, phong kham...)
  - Giao duc / Dao tao
  - Cong nghe / IT
  - San xuat
  - Khac (ghi ro)
- Logic: Khi chon "Khac (ghi ro)" → hien them field text "Ghi ro linh vuc"

### 8. Ban muon tro ly lam gi?
- Loai: Checkbox (chon nhieu)
- Bat buoc: Yes (chon it nhat 1)
- Options:
  - Tra loi tin nhan Zalo khach hang
  - Cham soc nhom Zalo
  - Quan ly Google Calendar (sap co)
  - Doc & tom tat email Gmail (sap co)
  - Bao cao sang hang ngay qua Telegram
  - Dang bai Facebook Fanpage (sap co)
  - Soan noi dung marketing
  - Cap nhat tin tuc nganh hang ngay
  - Khac (ghi ro)

### 9. Ban da co may tinh chua?
- Loai: Radio
- Bat buoc: Yes
- Options:
  - Da co
  - Chua co, can MODORO ho tro mua

### 10. Chon ngay cai dat
- Loai: Date picker
- Bat buoc: Yes
- Min date: 10/04/2026 (cap nhat moi dot ban moi)

### 11. Khung gio mong muon
- Loai: Dropdown
- Bat buoc: Yes
- Options:
  - Sang (9h - 12h)
  - Chieu (13h - 17h)
  - Toi (19h - 21h)

### 12. Ghi chu them
- Loai: Long text
- Bat buoc: No

### 13. Dong y xu ly du lieu
- Loai: Checkbox (1 option)
- Bat buoc: Yes
- Text: "Toi dong y cho MODORO xu ly thong tin ca nhan de cai dat va ho tro tro ly AI (theo ND 13/2023/ND-CP)"

---

## Luu y khi tao form

- Title: "MODOROClaw — Dang ky cai dat tro ly AI"
- Description: "Vui long dien thong tin ben duoi de team MODORO len lich cai dat tro ly AI cho ban. Thoi gian cai dat khoang 1-2 tieng qua remote (TeamViewer)."
- Confirmation message: "Cam on ban da dang ky! Team MODORO se lien he qua Telegram/Zalo de xac nhan lich cai dat."
- Mac dinh tat ca khach chua cai. MODORO team remote cai qua TeamViewer.
- Form data chi cho MODORO staff su dung, khong feed vao wizard tu dong.
- Field 10 min date can update moi dot ban moi.
