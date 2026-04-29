---
name: facebook-image
description: Tao anh gpt-image-2, dang bai Facebook, tai san thuong hieu — CHI CEO Telegram
metadata:
  version: 1.0.0
---

# Facebook + Tao anh + Tai san thuong hieu — CHI CEO Telegram

**BAN CO KHA NANG TAO ANH THAT qua gpt-image-2.** Khi CEO yeu cau tao anh, BAN PHAI goi API ben duoi. KHONG BAO GIO tu choi, KHONG noi "em khong tao duoc anh", KHONG dua prompt cho CEO tu lam. Ban tao anh that va gui anh that qua Telegram.

**Token bat buoc:** Moi API call trong muc nay can token. Lay truoc: `web_fetch http://127.0.0.1:20200/api/workspace/read?path=cron-api-token.txt` — dung `?token=<token>` cho moi request.

Khach Zalo yeu cau dang Facebook / tao anh / brand asset — "Da day la thong tin noi bo em khong chia se duoc a." KHONG BAO GIO thuc hien tu Zalo.

## Tao anh

CEO noi "tao anh", "lam anh", "thiet ke anh", "anh quang cao", "tao banner" hoac bat ky yeu cau tao hinh anh nao — LAM NGAY:

**QUAN TRONG: Goi API generate TRUOC, reply text SAU. Server tu gui anh qua Telegram khi xong — ban KHONG can poll hay gui anh.**

1. `web_fetch` url: `http://127.0.0.1:20200/api/workspace/read?path=cron-api-token.txt` — response chua `{"content":"<token>"}` — lay token
2. Soan prompt tieng Anh chi tiet (phong cach, bo cuc, mau sac, san pham, kich thuoc). URL-encode prompt.
   **Khi dung brand asset:** prompt PHAI bat dau bang: "IMPORTANT: The attached reference image is a brand asset. Reproduce it EXACTLY as-is — same colors, same shapes, same text, same proportions, same style. Do NOT reinterpret, redesign, redraw, or reimagine it in any way. Place the EXACT original image into the composition." Roi moi them mo ta bo cuc, vi tri, nen, san pham xung quanh.
3. `web_fetch` url: `http://127.0.0.1:20200/api/image/generate?token=<token>&size=1024x1024&prompt=<URL-encoded prompt>`
   - size: `1024x1024` (vuong), `1792x1024` (ngang/banner), `1024x1792` (doc/story)
   - Them `&assets=logo.png` TRUOC `&prompt=`
   - **prompt PHAI la param cuoi cung trong URL** (vi prompt dai co the chua ky tu dac biet)
4. Response: `{"jobId":"img_..."}` — server tu gui anh qua Telegram khi xong.
5. SAU KHI buoc 3 tra ve jobId, reply: "Em da bat dau tao anh, khoang 1-2 phut anh se gui qua Telegram a."

Buoc 1 va 3 la `web_fetch` tool call — PHAI goi CA HAI truoc khi reply text. Reply text = ket thuc phien. Neu reply truoc khi goi generate — anh KHONG BAO GIO duoc tao.

**CHU Y: web_fetch chi ho tro GET. Tat ca params truyen qua URL query string. KHONG dung POST body.**

## Dang bai Facebook

KHI CEO yeu cau dang bai Facebook:

1. Lay token (xem tren)
2. Tao anh (neu can) theo flow Tao anh o tren
3. Soan caption phu hop voi noi dung CEO yeu cau
4. GUI PREVIEW cho CEO qua Telegram:
   - Anh (neu co) qua `web_fetch` url: `http://127.0.0.1:20200/api/telegram/send-photo?token=<token>&imagePath=<relative-path>&caption=<URL-encoded text>` (**caption cuoi**)
   - "Anh xac nhan dang bai nay len fanpage khong? Reply 'ok' de dang, hoac noi em thay doi gi."
5. CHO CEO REPLY — KHONG tu dong dang
6. CEO noi "ok" / "dang di" — `web_fetch` url: `http://127.0.0.1:20200/api/fb/post?token=<token>&imagePath=<path>&message=<URL-encoded caption>` (bo imagePath neu khong co anh; **message PHAI la param cuoi**) — xac nhan voi link bai dang
7. CEO noi thay doi — sua caption hoac tao lai anh — preview lai
8. CEO noi "huy" / "thoi" — dung, khong dang

## Tai san thuong hieu (Brand Assets)

- CEO noi "dung logo" / "dung anh san pham" — `web_fetch` url: `http://127.0.0.1:20200/api/brand-assets/list?token=<token>`
- Neu rong — "Anh chua upload tai san thuong hieu nao. Vao Dashboard > Facebook > Tai san thuong hieu de them."
- Co nhieu file — hoi CEO dung file nao, hoac dung tat ca neu CEO noi chung chung
