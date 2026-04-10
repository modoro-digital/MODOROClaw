# MEMORY.md — Bảng Chỉ Mục

> Đây là bảng tham chiếu nhẹ. Chi tiết nằm trong các file liên kết.
> Nạp file này mỗi phiên (~1-2k tokens). Chỉ đi sâu vào file chi tiết khi cần.

---

## ⚠️ Ngữ cảnh đang hoạt động (luôn nạp trong phiên chính)
Các file này chứa ngữ cảnh quan trọng đang diễn ra. Nạp khi bắt đầu phiên.
- `memory/people/user.md` — Chủ nhân, luôn liên quan
- `memory/projects/example-project.md` — Dự án đang hoạt động

## 👤 Người
| Tên | Vai trò | Liên hệ gần nhất | Chi tiết | Từ khoá kích hoạt |
|-----|---------|-------------------|----------|---------------------|
| [Tên chủ nhân] | Chủ nhân / Sếp | [Ngày] | [user.md](memory/people/user.md) | chủ nhân, sếp, boss |
| [Tên agent] | Đồng nghiệp AI | [Ngày] | [colleague.md](memory/people/colleague.md) | agent, đồng nghiệp |
| [Liên hệ 1] | Bạn bè | [Ngày] | [contact1.md](memory/people/contact1.md) | [tên] |
| [Liên hệ 2] | Khách hàng | [Ngày] | [contact2.md](memory/people/contact2.md) | [tên] |

## 📁 Dự án
| Dự án | Trạng thái | Cập nhật | Chi tiết | Từ khoá kích hoạt |
|-------|------------|----------|----------|---------------------|
| Dự án mẫu | Đang chạy | [Ngày] | [example-project.md](memory/projects/example-project.md) | dự án, project |
| Dự án phụ | Đang lên kế hoạch | [Ngày] | [side-project.md](memory/projects/side-project.md) | dự án phụ |
| Mục tiêu học tập | Đang chạy | [Ngày] | [learning-goal.md](memory/projects/learning-goal.md) | học tập |

## 📋 Quyết định gần đây (30 ngày gần nhất)
| Ngày | Quyết định | Chi tiết |
|------|-----------|----------|
| [Ngày] | [Mô tả quyết định] | [Link đến chi tiết] |
| [Ngày] | [Mô tả quyết định] | [Link đến chi tiết] |

## 🔧 Tuỳ chọn đang áp dụng
- [Tuỳ chọn 1]: [giá trị]
- [Tuỳ chọn 2]: [giá trị]
- [Tuỳ chọn 3]: [giá trị]

## 🧠 Quy tắc đi sâu
1. **Cuộc trò chuyện nhắc đến một người?** → Nạp file trong people/
2. **Đang làm dự án?** → Nạp file trong projects/
3. **Đang ra quyết định?** → Kiểm tra decisions/ xem có tiền lệ
4. **Không chắc về ngữ cảnh?** → Dùng memory_search hoặc vector memory
5. **Bắt đầu phiên:** Luôn nạp các file Ngữ cảnh đang hoạt động (tối đa 2-3)
6. **Giới hạn cứng:** Tối đa 5 lần đi sâu khi bắt đầu phiên

## 📂 File tham khảo khác
| File | Nội dung |
|------|----------|
| memory/accounts.md | Tài khoản dịch vụ và nền tảng |
| memory/pending-tasks.md | Task đang chờ xử lý |
| docs/agent-architecture.md | Kiến trúc đa agent |
| docs/task-routing.md | Quy tắc phân bổ công việc |
| docs/morning-brief-template.md | Mẫu báo cáo buổi sáng |

## Nhat ky hang ngay
Nhat ky tho: `memory/YYYY-MM-DD.md` (append-only, audit trail).
Chi nap khi can chi tiet cu the ve ngay nao do.

## Tom tat tu dong
Cron tu dong tao:
- `memory/YYYY-MM-DD-summary.md` — tom tat 24h (bullet points). Dung cho weekly/monthly reports.
- `memory/week-YYYY-WNN-summary.md` — tom tat tuan (7 daily summaries). Dung cho monthly reports.
Cac file nay duoc tao tu dong. KHONG can tao thu cong.

## Lich su khach hang
`memory/zalo-users/<senderId>.md` ngoai frontmatter (ten, tag, phone), con co cac section `## YYYY-MM-DD` chua tom tat tuong tac tung ngay. Bot doc nhung section nay khi khach reply.

---

*Cập nhật lần cuối: [Ngày]*
*Cập nhật bảng chỉ mục này mỗi khi cập nhật file chi tiết. Cùng lúc. Không ngoại lệ.*
