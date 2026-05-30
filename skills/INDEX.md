# Skills — Thư viện kỹ năng

Bot TỰ ĐỘNG đọc INDEX này và chọn skill phù hợp MỖI KHI CEO yêu cầu.

## Cách hoạt động
1. CEO nhắn yêu cầu qua Telegram
2. Bot đọc INDEX → match keyword → đọc skill file tương ứng
3. Bot follow quy trình trong skill → output chất lượng cao

## Vận hành bot (28 skills) -- `skills/operations/`

| Skill | File | Khi nào dùng |
|---|---|---|
| Zalo (CSKH + nhóm + reply rules) | `zalo.md` | MỌI tin Zalo -- phạm vi + 22 trigger phòng thủ + format + nhóm + memory + escalate |
| Quản lý lịch tự động | `cron-management.md` | Tạo/sửa/xóa cron, lên lịch gửi tin |
| Tra cứu kiến thức | `knowledge-base.md` | Tra cứu tài liệu để trả lời khách |
| Theo dõi khách hàng | `follow-up.md` | Follow-up khách chưa phản hồi + truy vấn ad-hoc |
| Quản lý kênh | `channel-control.md` | Tạm dừng/tiếp tục kênh, blocklist |
| Hành vi veteran | `veteran-behavior.md` | Persona, tier khách, cultural, tone match (v2 -- ví dụ cụ thể) |
| Kênh CEO Telegram | `telegram-ceo.md` | Tư duy cố vấn + gửi Zalo từ Telegram (group/cá nhân) |
| Workspace API | `workspace-api.md` | Đọc/ghi/list file nội bộ + đơn hàng + tồn kho + nghỉ phép |
| CEO File API | `ceo-file-api.md` | Đọc/ghi/list/exec file trên máy CEO |
| Bộ nhớ CEO | `ceo-memory-api.md` | Lưu/tìm/xóa ký ức qua API |
| Tạo ảnh + Brand assets | `image-generation.md` | Tạo ảnh AI, brand assets, skill ảnh mẫu |
| Chuỗi workflow | `workflow-chains.md` | Kết hợp nhiều API thành chuỗi tự động |
| Tạo skill mới | `skill-builder.md` | CEO tạo/sửa/xóa skill tùy chỉnh qua chat |
| Sinh script tự động | `script-generator/SKILL.md` | Tạo Python/Node script cho task lặp lại (Node.js fallback cho Mac) |
| Viết bài bán hàng | `viet-bai-ban-hang.md` | Viết bài bán hàng Zalo / mạng xã hội kiểu người thật, 3 phiên bản |
| Soạn báo giá | `bao-gia.md` | Soạn báo giá/proposal nhanh + xuất file Word |
| Theo dõi công nợ | `cong-no.md` | Ghi nợ, trả nợ, nhắc nợ, cảnh báo quá hạn |
| Sổ sách đơn giản | `so-sach-don-gian.md` | Thu chi hàng ngày, báo cáo tuần/tháng |
| Kịch bản bán hàng | `kich-ban-ban-hang.md` | Script bán hàng + xử lý 7 tình huống từ chối |
| Checklist vận hành | `checklist-van-hanh.md` | Mở/đóng cửa, giao ca, kiểm kho -- theo ngành |
| Tuyển dụng nhanh | `tuyen-dung-nhanh.md` | JD + bài đăng group tuyển dụng + câu hỏi phỏng vấn |
| Báo cáo ngày | `bao-cao-ngay.md` | Tóm tắt ngày/tuần: 1 API call composite |
| Xử lý Excel | `../anthropic-xlsx/SKILL.md` | Đọc, tóm tắt, sửa, tạo file .xlsx trên máy CEO |
| Tạo file Word/DOCX | `../anthropic-docx/SKILL.md` | Tạo báo giá, hợp đồng, báo cáo, đề xuất dạng Word |
| Tạo PowerPoint/PPTX | `../anthropic-pptx/SKILL.md` | Tạo slide thuyết trình, pitch deck, báo cáo PowerPoint |
| Tạo PDF | `../anthropic-pdf/SKILL.md` | Tạo PDF báo cáo, hợp đồng, proposal có layout đẹp |
| Xuất danh sách khách Zalo (CRM) | `zalo-followup-sheet.md` | 1 API call xuất danh sách khách Zalo ra danh sách CRM |

## Marketing (1 skill) — `skills/marketing/`

| Skill | File | Khi nào dùng |
|---|---|---|
| Zalo Post Workflow | `zalo-post-workflow.md` | Tạo ảnh AI rồi gửi nhóm Zalo — CHỈ CEO Telegram |

## Quản lý nghiệp vụ (qua API composite) -- tích hợp trong `workspace-api.md`

| Nghiệp vụ | Endpoint | Trigger |
|---|---|---|
| Quản lý đơn hàng | `/api/order/*` | "ghi đơn", "đơn hàng", "order", "xem đơn" |
| Quản lý tồn kho | `/api/inventory/*` | "tồn kho", "kiểm kho", "nhập hàng", "xuất hàng" |
| Nghỉ phép / Chấm công | `/api/leave/*` | "xin nghỉ", "nghỉ phép", "chấm công" |
| Báo cáo tổng hợp | `/api/report/daily` | "báo cáo ngày", "hôm nay thế nào" |
| Xuất danh sách khách | `/api/zalo-crm/export` | "tổng hợp khách Zalo", "xuất danh sách khách" |
| Tạo bảng .xlsx | local `.xlsx` (anthropic-xlsx skill) | "tạo bảng theo dõi", "tạo file Excel" |

## Theo ngành (9 skills) -- `skills/`

| Skill | File | Khi nào dùng |
|---|---|---|
| Quản lý lịch hẹn CEO | `appointments.md` | Lịch hẹn khách, nhắc, push Zalo group |
| Bất động sản | `bat-dong-san.md` | Môi giới BĐS, dự án, hợp đồng + API đơn hàng/nghỉ phép |
| Công nghệ / IT | `cong-nghe.md` | SaaS, sprint, SLA + API đơn hàng/nghỉ phép |
| Dịch vụ (spa/salon/clinic) | `dich-vu.md` | Đặt lịch, vật tư + API tồn kho/nghỉ phép |
| F&B | `fnb.md` | Checklist, đặt bàn, menu + API tồn kho/đơn hàng |
| Giáo dục / Đào tạo | `giao-duc.md` | Lịch học, tuyển sinh + API đơn hàng/nghỉ phép |
| Sản xuất | `san-xuat.md` | Đơn sản xuất, QC + API tồn kho/đơn hàng |
| Thương mại / Bán lẻ | `thuong-mai.md` | Tồn kho, đơn hàng, đổi trả + API tồn kho/đơn hàng |
| Tổng quát (đa ngành) | `tong-quat.md` | Công việc chung + API báo cáo/đơn hàng/nghỉ phép |

## Mẫu ảnh (CEO tạo) — `skills/image-templates/`

CEO tạo skill ảnh qua Telegram ("tạo skill ảnh mới"). Gọi `GET /api/image/skills` để xem danh sách.

## Skill tùy chỉnh (CEO tạo) — `user-skills/`

CEO tạo skill riêng qua Telegram ("tạo skill mới"). Đọc `skill-builder.md` cho quy trình. Hệ thống tự động inject skill phù hợp (theo trigger keyword match) vào tin nhắn của khách trước khi bot xử lý — bot KHÔNG cần tự đọc file skill.

---

**Tổng: 39 skill cơ bản + 6 API composite + mẫu ảnh + skill tùy chỉnh CEO tạo** cho chủ doanh nghiệp Việt Nam.
API composite (đơn hàng, tồn kho, nghỉ phép, báo cáo, CRM export, Sheet format) tích hợp sẵn trong workspace-api.md -- không cần skill riêng, bot gọi trực tiếp.
