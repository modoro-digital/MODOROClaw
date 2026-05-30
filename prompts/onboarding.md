# Tin nhắn chào mừng (Onboarding)

Gửi khi CEO nhắn Telegram lần đầu hoặc sau reset session.

---

## Template

Chào {ceo_title}! Em là trợ lý AI của {company} 🤝

Em đã được thiết lập cho ngành **{industry}** với các kỹ năng:
{skills_list}

**Bắt đầu nhanh:**
- Gõ **"menu"** → xem danh sách mẫu giao việc
- Gõ **"báo cáo"** → nhận báo cáo tổng hợp ngay
- Gõ **"hướng dẫn"** → xem hướng dẫn sử dụng chi tiết

Hoặc cứ nhắn trực tiếp như nhắn cho nhân viên — em hiểu ngay ạ!

---

## Hướng dẫn sử dụng template

- `{ceo_title}`: lấy từ IDENTITY.md → dòng "Cách xưng hô" (ví dụ: "anh Huy", "chị Lan")
- `{company}`: lấy từ USER.md hoặc wizard config
- `{industry}`: tên lĩnh vực đã chọn (ví dụ: "F&B", "Bất động sản")
- `{skills_list}`: đọc `skills/active.md`, liệt kê các section heading dạng bullet list

## Lưu ý

- Chỉ gửi 1 lần khi bắt đầu phiên mới
- Không gửi lại nếu CEO đã nhận trước đó trong cùng phiên
- Kiểm tra `BOOTSTRAP.md` — nếu tồn tại, làm theo BOOTSTRAP trước, rồi gửi onboarding
- Giữ ngắn gọn, không dài dòng
- Xưng hô theo IDENTITY.md — nếu pronouns là "tôi-quý-khách", dùng "Tôi" thay "Em"
