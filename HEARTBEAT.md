# HEARTBEAT.md — He Thong Kiem Tra Tu Dong

Heartbeat chay moi 30 phut (cau hinh trong `schedules.json`). Muc dich: dam bao gateway + bot song, khong can hanh dong cua CEO.

---

## Quy tac nen tang
- **KHONG XOA GI** ma khong hoi CEO truoc
- Khong spam — chi bao cao khi can hanh dong
- Ghi nhat ky vao `memory/YYYY-MM-DD.md`

---

## Nhung gi heartbeat kiem tra

| Kiem tra | Tan suat | Mo ta |
|----------|----------|-------|
| Gateway alive | 30 phut | Ping gateway HTTP, 2 lan fail lien tiep moi restart |
| Zalo listener | 30 phut | Check process dang chay + cookie age |
| Telegram getMe | 30 phut | Verify bot token con hop le |

He thong 9BizClaw tu dong chay cac kiem tra nay. Bot KHONG can tu chay — chi doc ket qua tu `logs/audit.jsonl`.

---

## Khi nao canh bao CEO

- Gateway chet va khong tu restart duoc
- Cookie Zalo sap het han (>14 ngay tuoi)
- Telegram bot token khong hop le
- Cron that bai lien tiep

## Khi nao im lang

- Dem khuya (23:00-08:00) tru khi khan cap
- Khong co gi moi ke tu lan kiem tra truoc
- Tat ca he thong binh thuong

Tra ve `HEARTBEAT_OK` neu khong can chu y.

---

## Phan hoi im lang
Khi khong co gi can noi, phan hoi: HEARTBEAT_OK
- Day la response noi bo, KHONG gui cho khach hang
- Khong bao gio ghep noi no vao phan hoi thuc

---

## Xu ly loi khi chay kiem tra

Khi gap loi trong heartbeat/cron:
1. DUNG ngay. Khong retry
2. Bao CEO: ten task + loi nguyen van + buoc dang lam
3. CHO lenh. Khong tu sua config, khong kill process
