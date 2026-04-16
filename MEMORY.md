# MEMORY.md — Bang Chi Muc

> Bang tham chieu nhe. Chi tiet nam trong cac file lien ket.
> Nap file nay moi phien (~1k tokens). Chi di sau vao file chi tiet khi can.

---

## Ngu canh dang hoat dong
Cac file nay chua ngu canh quan trong. Nap khi bat dau phien.
- `memory/YYYY-MM-DD.md` — Nhat ky hom nay (append-only)

## Nguoi
| Ten | Vai tro | Chi tiet | Tu khoa kich hoat |
|-----|---------|----------|---------------------|
| CEO | Chu nhan | Doc `IDENTITY.md` | chu nhan, sep, boss |

Bot tu tao ho so khach trong `memory/zalo-users/<senderId>.md` va `memory/zalo-groups/<groupId>.md`.

## Quy tac di sau
1. **Cuoc tro chuyen nhac den khach Zalo?** -> Nap file trong `memory/zalo-users/`
2. **Nhom Zalo?** -> Nap file trong `memory/zalo-groups/`
3. **Khach Zalo hoi sp/dich vu/gio/chinh sach?** -> CHI doc `knowledge/cong-ty/index.md` + `knowledge/san-pham/index.md` + `knowledge/nhan-vien/index.md`. KHONG dung COMPANY.md / PRODUCTS.md (2 file do tom luoc tu wizard, khong chinh xac).
4. **Khong chac ve ngu canh?** -> Dung `memory_search`
5. **Bat dau phien:** Nap `IDENTITY.md` + `active-persona.md` + `knowledge/cong-ty/index.md` + `knowledge/san-pham/index.md` + `knowledge/nhan-vien/index.md`. COMPANY.md/PRODUCTS.md CHI doc khi CEO tren Telegram can context noi bo.
6. **Gioi han cung:** Toi da 5 lan di sau khi bat dau phien

## File tham khao
| File | Noi dung |
|------|----------|
| `memory/zalo-users/<id>.md` | Ho so khach hang Zalo (ten, tag, lich su) |
| `memory/zalo-groups/<id>.md` | Ho so nhom Zalo (thanh vien, chu de) |
| `knowledge/*/index.md` | Tai lieu doanh nghiep (cong-ty, san-pham, nhan-vien) |
| `.learnings/LEARNINGS.md` | Bai hoc tu cac phien truoc |

## Nhat ky hang ngay
`memory/YYYY-MM-DD.md` (append-only, audit trail). Chi nap khi can chi tiet cu the ve ngay nao do.

## Lich su khach hang
`memory/zalo-users/<senderId>.md` ngoai frontmatter (ten, tag, phone), con co cac section `## YYYY-MM-DD` chua tom tat tuong tac tung ngay. Bot doc nhung section nay khi khach reply.

---

*Cap nhat bang chi muc nay moi khi cap nhat file chi tiet.*
