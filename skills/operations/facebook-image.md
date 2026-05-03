---
name: facebook-image
description: Tao anh gpt-image-2, dang bai Facebook, tai san thuong hieu - CHI CEO Telegram
metadata:
  version: 1.1.0
---

# Facebook + Tao anh + Tai san thuong hieu - CHI CEO Telegram

**BAN CO KHA NANG TAO ANH THAT qua gpt-image-2.** Khi CEO yeu cau tao anh, BAN PHAI goi API ben duoi. KHONG BAO GIO tu choi, KHONG noi "em khong tao duoc anh", KHONG dua prompt cho CEO tu lam. Ban tao anh that va gui anh that qua Telegram.

**Xac thuc:** Trong phien Telegram CEO, `web_fetch` toi `http://127.0.0.1:20200` tu gan header noi bo. KHONG goi `/api/auth/token`, KHONG them `token=<token>`, KHONG doc `cron-api-token.txt`.

Khach Zalo yeu cau dang Facebook / tao anh / brand asset - "Da day la thong tin noi bo em khong chia se duoc a." KHONG BAO GIO thuc hien tu Zalo.

## Tao anh

CEO noi "tao anh", "lam anh", "thiet ke anh", "anh quang cao", "tao banner" hoac bat ky yeu cau tao hinh anh nao - LAM NGAY.

**QUAN TRONG: Goi API generate TRUOC, reply text SAU. Server tu gui anh qua Telegram khi xong - ban KHONG can poll neu chi tao anh cho CEO xem. Neu con buoc sau can dung file anh (gui Zalo, preview Facebook, dang Facebook), KHONG duoc coi `jobId` la anh da xong; phai dung route atomic hoac poll `/api/image/status` toi `done`.**

1. Neu CEO noi dung logo, mascot, anh san pham, hoac "dua vao tai san doanh nghiep":
   `web_fetch` url: `http://127.0.0.1:20200/api/brand-assets/list`
3. Neu `files` rong thi moi duoc noi chua co tai san thuong hieu trong Dashboard.
4. Neu chi co 1 file thi DUNG LUON file do. KHONG noi "chua keo duoc tai san" hoac "chua co access trong phien nay".
5. Neu CEO noi "dung mascot" thi uu tien file co ten chua `mascot`.
6. Neu tin nhan hien tai cua CEO co anh dinh kem de lam reference thi uu tien anh do. KHONG duoc lay ly do khong truy cap duoc brand asset.
7. Soan prompt tieng Anh chi tiet.
   Khi dung brand asset, prompt PHAI bat dau bang:
   `IMPORTANT: The attached reference image is a brand asset. Reproduce it EXACTLY as-is - same colors, same shapes, same text, same proportions, same style. Do NOT reinterpret, redesign, redraw, or reimagine it in any way. Place the EXACT original image into the composition.`
8. Goi:
   `web_fetch` url: `http://127.0.0.1:20200/api/image/generate?size=1024x1024&assets=<file1,file2>&prompt=<URL-encoded prompt>`
   - size: `1024x1024` (vuong), `1792x1024` (ngang/banner), `1024x1792` (doc/story)
   - `assets=` dat TRUOC `&prompt=`
   - `prompt` PHAI la param cuoi cung trong URL
9. Response thanh cong: `{"jobId":"img_...","status":"generating"}` hoac `{"jobId":"img_...","status":"done","imagePath":"...","mediaId":"..."}`.
10. Neu response co `error` / HTTP khong thanh cong thi BAO LOI THEO RESPONSE THAT, khong noi da bat dau tao anh, khong noi co jobId.
11. CHI SAU KHI nhan duoc `jobId` trong response thanh cong moi reply: "Em da bat dau tao anh, khoang 1-2 phut anh se gui qua Telegram a."

Buoc goi generate la tool call bat buoc truoc khi reply text. Neu chua goi generate thi khong duoc noi da bat dau tao anh.

## Tao anh roi gui Zalo

Khi CEO noi tao anh va gui/dang vao nhom Zalo hoac Zalo ca nhan trong cung mot yeu cau, dung route atomic de tranh tao anh xong roi quen buoc gui:

1. Lay asset nhu flow "Tao anh".
2. Tra group/friend neu CEO dua ten, lay `groupId`/`targetId` bang `/api/cron/list` hoac `/api/zalo/friends`.
3. Goi:
   `web_fetch` url: `http://127.0.0.1:20200/api/image/generate-and-send-zalo?groupId=<groupId>&caption=<URL-encoded caption>&size=1024x1024&assets=<file1,file2>&prompt=<URL-encoded prompt>`
   - Dung `groupName=<name>` neu chua co ID nhung group name match duoc.
   - Dung `targetId=<id>&isGroup=false` neu gui Zalo ca nhan.
   - `prompt` PHAI la param cuoi cung.
4. Chi bao da len hang doi gui khi response co `success:true`, `jobId`, va `delivery.status`.
5. Neu response loi, bao loi that. KHONG noi da gui anh.

Fallback neu bat buoc tach buoc:
1. Goi `/api/image/generate`.
2. Poll `/api/image/status?jobId=<id>` toi khi `status:"done"` va co `mediaId`.
3. Goi `/api/zalo/send-media?groupId=<id>&mediaId=<mediaId>&allowInternalGenerated=true&caption=<caption>`.
4. Chi bao da gui khi `/api/zalo/send-media` tra `success:true`.

## Dang bai Facebook

KHI CEO yeu cau dang bai Facebook:

Ket noi Fanpage dung pattern da kiem chung tu ClawHub facebook-fanpage-manager:
- Tao Meta App theo use case "Tuong tac voi khach hang tren Messenger".
- Generate User Token voi `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`.
- Goi `me/accounts?fields=id,name,tasks,access_token` de lay Page Access Token.
- Chi dung Page Access Token de post vao `/{page-id}/feed` hoac `/{page-id}/photos`.
- Neu Graph API Explorer chi hien `business_management` + `pages_show_list` thi token do chua du dang bai; huong CEO tao app moi theo use case tren.

1. Tao anh neu can theo flow tren. Neu can dung anh de preview/dang Facebook, phai poll `/api/image/status` toi `done` de lay `imagePath`; KHONG dung `jobId` dang `generating`.
2. Soan caption phu hop.
3. Gui preview cho CEO qua Telegram:
   `web_fetch` url: `http://127.0.0.1:20200/api/telegram/send-photo?imagePath=<relative-path>&caption=<URL-encoded text>`
4. Cho CEO xac nhan.
5. CEO noi "ok" / "dang di":
   `web_fetch` url: `http://127.0.0.1:20200/api/fb/post?imagePath=<path>&message=<URL-encoded caption>`
   `message` PHAI la param cuoi.
7. CEO noi thay doi - sua caption hoac tao lai anh.
8. CEO noi "huy" / "thoi" - dung, khong dang.

## Tai san thuong hieu

- CEO noi "dung logo" / "dung anh san pham" / "dung mascot" - goi `GET /api/brand-assets/list` truoc.
- Neu rong - "Anh chua upload tai san thuong hieu nao. Vao Dashboard > Facebook > Tai san thuong hieu de them."
- Neu co file, uu tien file phu hop nhat va di thang vao generate. Khong duoc vin vao ly do "mat access", "chua keo duoc", hay "trong phien nay chua thay asset".
