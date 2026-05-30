# Quy trinh mua hang 9BizClaw — Tu quan tam den chay bot

## TONG QUAN FLOW

```
Khach hoi → Bot tu van → Khach muon mua → Bot chuyen CEO
→ CEO bao gia + gui STK → Khach CK → CEO confirm
→ Gui link tai + hen lich setup → Khach cai dat (wizard)
→ Remote support neu can → Bot chay, bat dau phuc vu
```

---

## BUOC 1: KHACH QUAN TAM (bot xu ly)

Khach nhan tin hoi ve 9BizClaw. Bot:
- Chao, hoi khach dang kinh doanh gi, gap van de gi
- Tu van goi phu hop (Premium vs Signature)
- Tra loi moi cau hoi ve tinh nang, gia, ky thuat
- Xem chi tiet tai lieu: `9bizclaw-product-knowledge.md`

**Mau cau mo dau:**
"Da 9BizClaw la tro ly AI giup anh/chi tu dong tra loi khach hang tren Zalo 24/7 a. Anh/chi dang kinh doanh linh vuc gi de em tu van goi phu hop a?"

## BUOC 2: KHACH MUON MUA (bot chuyen CEO)

Khi khach noi bat ky cau nao sau:
- "Muon mua", "dang ky", "thanh toan sao", "chuyen khoan sao"
- "Lay goi Premium", "bat dau dung", "setup di"
- "Gui STK", "so tai khoan", "bank"
- "Gia cuoi bao nhieu", "chot di"

Bot tra loi:
"Da cam on anh/chi da quan tam a. De em chuyen sep xu ly thanh toan va huong dan setup truc tiep cho anh/chi. Sep se lien he trong vong [thoi gian] a."

→ **ESCALATE CEO** ngay. Bot KHONG tu gui STK, KHONG tu bao gia khac bang gia niem yet.

**Thong tin gui CEO (qua Telegram alert):**
- Ten khach (neu biet)
- Goi quan tam: Premium hay Signature
- Van de/nhu cau cu the khach chia se
- Lich su hoi dap (tom tat)

## BUOC 3: CEO XU LY THANH TOAN (CEO truc tiep)

CEO lien he khach truc tiep qua Zalo/DT:
- Xac nhan goi + gia
- Gui thong tin chuyen khoan
- Khach CK → CEO kiem tra → xac nhan

**Bot KHONG biet va KHONG can biet:**
- So tai khoan ngan hang
- Ma giao dich
- Trang thai chuyen khoan

Neu khach hoi bot "da CK roi", "chuyen khoan roi":
→ "Da em ghi nhan a. Sep se kiem tra va xac nhan trong thoi gian som nhat. Neu qua [X gio] chua co phan hoi, anh/chi nhan lai em nhe a."

## BUOC 4: GIAO HANG PHAN MEM (sau CEO confirm)

### Goi Premium:
1. CEO gui link tai file cai dat (EXE cho Windows, DMG cho Mac)
2. Khach tai va cai dat — wizard tu huong dan tung buoc:
   - Buoc 1: Ket noi Zalo (quet QR)
   - Buoc 2: Ket noi AI (dang nhap ChatGPT)
   - Buoc 3: Tao Telegram bot
   - Buoc 4: Upload tai lieu san pham
3. Neu khach can ho tro → hen lich remote setup (TeamViewer/AnyDesk)
4. Bot san sang — bat dau tra loi khach

### Goi Signature:
1. Hop dong dich vu chinh thuc
2. Ky thuat den truc tiep cai dat, cau hinh
3. Train bot theo nghiep vu cu the
4. 10+ buoi dao tao Zoom
5. Bao gom PC chuyen dung (duoi 30 trieu), cai san, ship tan noi

## BUOC 5: ONBOARDING (bot ho tro)

Sau khi khach cai xong, bot co the tra loi:
- "Lam sao upload tai lieu?" → Huong dan mo Dashboard → Knowledge → Upload
- "Lam sao tao cron?" → Huong dan nhan Telegram: "moi sang 9h gui nhom X chao buoi sang"
- "Bot tra loi sai, chinh sao?" → Nhan Telegram: "tu gio khi khach hoi bao hanh, tra loi 12 thang"
- "Lam sao chan nguoi spam?" → Dashboard → Zalo → Blocklist
- "May tat bot co chay khong?" → Khong. May phai bat. Goi Signature co PC chuyen dung chay 24/7
- "Lam sao xem bao cao?" → Telegram nhan bao cao tu dong moi sang/toi

**Buoi cai dat chung hang tuan:**
- Online qua Zoom, co huong dan truc tiep
- Danh cho Premium. Signature co lich rieng.

## BUOC 6: SUPPORT SAU MUA (bot + CEO)

Bot xu ly:
- Hoi dap tinh nang, cach dung
- Loi co ban (restart, ket noi lai Zalo/Telegram)
- Huong dan upload tai lieu, tao cron, config

CEO xu ly (bot escalate):
- Loi ky thuat phuc tap
- Yeu cau tinh nang moi
- Huy goi / hoan tien
- Nang cap Premium → Signature

---

## CAU HOI KHACH THUONG HOI VE QUY TRINH

**"Mua roi bao lau co dung duoc?"**
→ Sau khi CEO xac nhan thanh toan, anh/chi nhan link tai ngay. Cai dat mat khoang 15 phut, wizard huong dan tung buoc. Bot chay ngay sau khi cai xong a.

**"Co ai huong dan cai dat khong?"**
→ Da co a. App co wizard tu dong huong dan. Neu anh/chi can ho tro them, ben em co buoi cai dat chung hang tuan (online). Hoac em hen lich remote vao may anh/chi setup truc tiep.

**"May minh yeu co chay duoc khong?"**
→ Chi can Windows 10/11 hoac Mac, RAM 4GB tro len, o cung con 2GB. Khong can may manh — bot nhe, chay nen a.

**"Minh can ChatGPT Plus ha? Them 20 USD/thang?"**
→ Da dung a. ChatGPT Plus 20 USD/thang (~500k VND). Day la chi phi AI duy nhat — 9BizClaw khong tinh them phi token. Tong chi phi nam dau: 9BizClaw 6tr/nam + ChatGPT ~6tr/nam = khoang 12tr/nam (1tr/thang).

**"Khong co ChatGPT Plus thi sao?"**
→ Can ChatGPT Plus hoac Pro de bot chay lien tuc a. Free khong du quota cho bot xu ly nhieu tin nhan. Anh/chi dang ky tai chat.openai.com, mat 2 phut.

**"Mua cho nhieu chi nhanh duoc khong?"**
→ Moi license cho 1 may. Nhieu chi nhanh can mua them license. Hoac xem goi Signature co giai phap tong the hon a. De em chuyen sep tu van chi tiet.

**"Co hoa don khong?"**
→ Da co xuat hoa don VAT a. Anh/chi cung cap thong tin xuat hoa don khi thanh toan, CEO xu ly.

**"Thanh toan hang thang hay nam?"**
→ Thanh toan theo nam a. Gia 6 trieu/nam cho goi Premium, tinh ra chi 500k/thang. Anh/chi thanh toan 1 lan dung ca nam.
