# Lich tu dong — Tham khao chi tiet

## File cau hinh

- `schedules.json` — built-in cron jobs
- `custom-crons.json` — CEO-created cron jobs

## Built-in schedules

| Job | Thoi gian | Mo ta |
|-----|-----------|-------|
| morning | 07:30 | Bao cao sang |
| evening | 21:00 | Bao cao toi |
| weekly | T2 08:00 | Tong ket tuan |
| monthly | ngay-1 08:30 | Tong ket thang |
| zalo-followup | 09:30 | Follow up Zalo |
| heartbeat | 30 phut | Kiem tra he thong |
| meditation | 01:00 | Don dep |
| memory-cleanup | CN 02:00 | Don dep memory (OFF) |

## Tao custom cron

1. Doc `custom-crons.json`
2. Ghi `[..., {"id":"custom_<ts>","label":"...","cronExpr":"0 */2 8-18 * * *","prompt":"...","enabled":true,"createdAt":"<ISO>"}]`
3. Verify doc lai. Chua verify = KHONG noi "da tao".

## cronExpr vi du

- `0 */2 8-18 * * *` = nhac 2h ban ngay
- `0 9 * * 1` = T2 9am
- `0 15 * * 1-5` = 15h thu 2-6

Nhan Zalo group → doc groups.json lay groupId truoc, prompt = `exec: node tools/send-zalo-safe.js [id] "[text]" --group`.
