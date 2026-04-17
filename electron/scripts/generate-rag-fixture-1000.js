#!/usr/bin/env node
// Generate a 200-chunk × 1000-query RAG fixture spanning 10 industries so
// we can quantify v2.3.46 FTS5 vs v2.3.47 semantic uplift honestly on a
// diverse corpus (not just 25 electronics chunks).
//
// Design:
//   10 industries × 20 chunks = 200 chunks
//   10 query categories × 100 queries = 1000 queries
//   Each query has expected_ids based on template-to-chunk mapping
//
// Categories (same as 100-query): typo, no-diacritic, negation, number-range,
// comparison, short, eng-mix, brand-only, OOD, compound.

const fs = require('fs');
const path = require('path');

// ---------- helpers ----------
const stripVi = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
const typo = s => s.replace(/.$/, '').replace(/\s+/g, ' '); // crude: drop last char
const lowerVi = s => stripVi(s).toLowerCase();

// ---------- industries ----------
// Each industry has: id, label (VI), chunks[], queryPatterns
// Chunks are realistic 1-2 sentence product/policy lines.
// Query patterns reference chunks by relative index within the industry.

const industries = [
  {
    id: 'phone', label: 'Điện thoại',
    chunks: [
      'iPhone 15 Pro Max 256GB titan tự nhiên giá 29.990.000 VND, bảo hành 12 tháng Apple.',
      'iPhone 15 Pro 128GB giá 24.990.000 VND, chip A17 Pro, camera 48MP.',
      'Samsung Galaxy S24 Ultra 512GB giá 28.990.000 VND, bút S Pen, IP68.',
      'Xiaomi 14 Ultra 16/512GB giá 27.990.000 VND, camera Leica, zoom 5x.',
      'iPhone 14 Pro Max 256GB cũ giá 18.990.000 VND, máy đẹp 99%, bảo hành shop 6 tháng.',
      'Oppo Find X7 Ultra 16/512GB giá 23.990.000 VND, màn LTPO 120Hz.',
      'iPhone 13 cũ 128GB giá 12.990.000 VND, pin 92%, đã active 1 năm.',
      'Vivo X100 Pro 12/256GB giá 19.990.000 VND, chip Dimensity 9300.',
      'Realme GT 6 12/256GB giá 14.990.000 VND, sạc nhanh 120W.',
      'Huawei Pura 70 Pro 12/256GB giá 22.990.000 VND, camera XMAGE.',
      'Google Pixel 8 Pro 256GB giá 19.990.000 VND, chip Tensor G3.',
      'OnePlus 12 16/512GB giá 18.990.000 VND, sạc 100W, màn 2K.',
      'Nothing Phone 2 12/256GB giá 13.990.000 VND, đèn Glyph.',
      'iPhone SE 2022 64GB giá 8.990.000 VND, chip A15, Touch ID.',
      'Samsung Galaxy A55 8/128GB giá 9.990.000 VND, chống nước IP67.',
      'Xiaomi Redmi Note 13 Pro 8/256GB giá 7.490.000 VND, camera 200MP.',
      'Oppo Reno 11F 8/256GB giá 8.990.000 VND, sạc SUPERVOOC 67W.',
      'Infinix Zero 30 12/256GB giá 6.990.000 VND, camera 4K 60fps.',
      'ASUS ROG Phone 8 16/512GB giá 25.990.000 VND, gaming flagship.',
      'Sony Xperia 1 VI 12/256GB giá 28.990.000 VND, màn 4K HDR.',
    ],
  },
  {
    id: 'fashion', label: 'Thời trang',
    chunks: [
      'Áo thun nam cotton 100% size S-XXL giá 250.000 VND, đủ màu đen trắng xanh.',
      'Quần jean nam slim fit size 29-34 giá 450.000 VND, chất liệu denim Nhật.',
      'Áo sơ mi nữ dài tay giá 350.000 VND, cotton lụa, form dáng thanh lịch.',
      'Váy đầm dự tiệc đen giá 890.000 VND, size S M L, thiết kế bodycon.',
      'Chân váy công sở midi giá 420.000 VND, vải tuyết mưa cao cấp.',
      'Áo khoác dạ nữ giá 1.290.000 VND, đủ màu camel đen navy, size S-L.',
      'Giày thể thao Nike Air Force 1 trắng giá 2.790.000 VND, size 38-44.',
      'Giày cao gót nữ 7cm giá 650.000 VND, da bò thật, gót nhọn.',
      'Túi xách nữ công sở giá 890.000 VND, da PU cao cấp đen nâu.',
      'Balo du lịch 30L giá 590.000 VND, chống nước, ngăn laptop 15 inch.',
      'Áo polo nam giá 320.000 VND, cotton cá sấu, form ôm body.',
      'Quần shorts nữ giá 280.000 VND, vải linen mềm mát, size S-L.',
      'Áo len nữ cổ tròn giá 490.000 VND, len lông cừu, giữ ấm mùa đông.',
      'Đồ ngủ pijama nữ giá 350.000 VND, satin lụa, set áo quần.',
      'Áo blazer nữ công sở giá 990.000 VND, dáng tây phom cứng.',
      'Quần tây nam giá 550.000 VND, vải kate Thái Lan, form ôm.',
      'Áo hoodie unisex giá 420.000 VND, nỉ bông, in hình graphic.',
      'Đầm maxi đi biển giá 690.000 VND, vải voan mềm bay, hoa văn nhiệt đới.',
      'Giày sandal nam quai ngang giá 380.000 VND, đế cao su chống trượt.',
      'Bộ vest nam 3 mảnh giá 3.990.000 VND, wool pha polyester, size 48-54.',
    ],
  },
  {
    id: 'fnb', label: 'Cà phê & đồ uống',
    chunks: [
      'Cà phê đen đá ly M giá 25.000 VND, hạt Arabica rang xay tại quán.',
      'Cà phê sữa nóng ly L giá 35.000 VND, sữa đặc Ông Thọ, đậm đà.',
      'Bạc xỉu đá giá 30.000 VND, pha sữa tươi tỉ lệ cà phê 2/8.',
      'Trà đào cam sả giá 45.000 VND, topping đào miếng, đá bào.',
      'Trà sữa trân châu đường đen size L giá 49.000 VND, 100% không phẩm màu.',
      'Nước ép cam tươi giá 40.000 VND, cam sành Vĩnh Long nguyên chất.',
      'Smoothie việt quất giá 55.000 VND, sữa chua Hy Lạp ít đường.',
      'Latte matcha giá 52.000 VND, bột matcha Uji Nhật Bản.',
      'Cappuccino hạt dẻ giá 50.000 VND, syrup Monin chính hãng.',
      'Americano giá 38.000 VND, nóng/đá tuỳ chọn, espresso 2 shot.',
      'Bánh mì thịt nguội giá 25.000 VND, pate gan gà tự làm.',
      'Bánh croissant bơ giá 32.000 VND, nướng giòn bơ Pháp.',
      'Mì ý sốt bò bằm giá 85.000 VND, pasta Ý nhập khẩu.',
      'Pizza margherita size M giá 129.000 VND, đế mỏng, phô mai mozzarella.',
      'Salad ức gà giá 65.000 VND, xà lách romaine, sốt caesar.',
      'Combo breakfast giá 89.000 VND: 1 cà phê + 1 bánh croissant + trứng.',
      'Happy hour 15h-17h giảm 30% toàn menu trà sữa và smoothie.',
      'Buổi sáng 7h-9h combo 49.000 VND: bánh mì + cà phê đá.',
      'Miễn phí WiFi tốc độ 100Mbps, ổ cắm điện mỗi bàn.',
      'Giao hàng qua GrabFood ShopeeFood, phí ship theo ứng dụng.',
    ],
  },
  {
    id: 'beauty', label: 'Mỹ phẩm',
    chunks: [
      'Kem chống nắng Anessa Perfect UV Sunscreen 60ml giá 690.000 VND, SPF 50+ PA++++.',
      'Sữa rửa mặt CeraVe Foaming Cleanser 236ml giá 320.000 VND, da dầu mụn.',
      'Serum vitamin C Paula Choice 30ml giá 1.490.000 VND, làm sáng da.',
      'Kem dưỡng ẩm La Roche Posay Toleriane 40ml giá 450.000 VND, da nhạy cảm.',
      'Son thỏi MAC Chili 3g giá 590.000 VND, màu đỏ gạch nude.',
      'Mascara Maybelline Sky High giá 290.000 VND, chống nước dày mi.',
      'Phấn má hồng 3CE Mood Recipe giá 420.000 VND, hiệu ứng gradient.',
      'Tẩy trang Bioderma Sensibio 500ml giá 690.000 VND, nước micellar Pháp.',
      'Nước hoa hồng Klairs Supple Preparation 180ml giá 390.000 VND, cấp ẩm.',
      'Mặt nạ giấy Mediheal N.M.F giá 35.000 VND 1 miếng, cấp nước.',
      'Kem nền Estee Lauder Double Wear 30ml giá 1.490.000 VND, lâu trôi.',
      'Bút kẻ mắt Bobbi Brown Long Wear giá 690.000 VND, đen đậm không lem.',
      'Tẩy tế bào chết Paula Choice BHA 118ml giá 790.000 VND, salicylic acid 2%.',
      'Kem mắt Kiehl\'s Avocado 14g giá 790.000 VND, bọng mắt quầng thâm.',
      'Sữa tắm Dove Deeply Nourishing 500ml giá 180.000 VND, dưỡng ẩm sâu.',
      'Dầu gội TRESemmé Keratin 650ml giá 260.000 VND, phục hồi tóc.',
      'Kem cạo râu Gillette 195g giá 120.000 VND, dành cho nam.',
      'Nước hoa nữ Chanel Coco Mademoiselle 50ml giá 3.690.000 VND, hương cam chanh.',
      'Nước hoa nam Dior Sauvage 100ml giá 3.290.000 VND, hương gỗ mạnh mẽ.',
      'Combo skincare CeraVe 3 món giá 890.000 VND: rửa mặt + toner + kem.',
    ],
  },
  {
    id: 'realestate', label: 'Bất động sản',
    chunks: [
      'Căn hộ 2PN Vinhomes Ocean Park 75m2 giá 3.9 tỷ, ban công hướng Đông Nam.',
      'Nhà phố Gamuda Gardens 80m2 x 3 tầng giá 8.5 tỷ, sổ đỏ chính chủ.',
      'Biệt thự Ecopark 200m2 x 3 tầng giá 15 tỷ, sân vườn rộng 50m2.',
      'Chung cư mini Cầu Giấy 35m2 1PN giá 1.2 tỷ, cách Keangnam 1km.',
      'Đất nền Hoà Lạc 100m2 giá 2.5 tỷ, mặt đường 10m, xây ngay.',
      'Căn hộ Masteri Thảo Điền 3PN 100m2 giá 9.5 tỷ, view sông Sài Gòn.',
      'Villa Flora Phú Quốc 400m2 giá 25 tỷ, hồ bơi riêng, biển 500m.',
      'Shop house Vinhomes Central Park giá 18 tỷ, mặt tiền 8m, 4 tầng.',
      'Cho thuê căn hộ Vinhomes 2PN giá 18 triệu/tháng, full nội thất.',
      'Cho thuê văn phòng Tôn Đức Thắng 50m2 giá 25 triệu/tháng.',
      'Đất thổ cư Long Biên 60m2 giá 4.2 tỷ, đường ô tô vào tận cửa.',
      'Căn hộ officetel quận 1 30m2 giá 2.8 tỷ, cho thuê 12tr/tháng.',
      'Nhà mặt phố Trần Duy Hưng 50m2 x 5 tầng giá 28 tỷ, kinh doanh tốt.',
      'Đất nền Đồng Nai 150m2 giá 1.8 tỷ, cách cao tốc 5km.',
      'Căn hộ dịch vụ Q7 35m2 giá 15 triệu/tháng, sát Crescent Mall.',
      'Biệt thự song lập Vinhomes Riverside 280m2 giá 32 tỷ, sân vườn hồ bơi.',
      'Penthouse Keangnam 240m2 giá 28 tỷ, 4PN view panoramic Mỹ Đình.',
      'Đất nền Bình Dương 120m2 giá 2.1 tỷ, pháp lý sổ đỏ từng nền.',
      'Căn hộ studio Landmark 81 40m2 giá 5.5 tỷ, view sông Sài Gòn.',
      'Shophouse Ocean Park 120m2 x 4 tầng giá 22 tỷ, kinh doanh ngay.',
    ],
  },
  {
    id: 'service', label: 'Dịch vụ (salon/gym/giặt)',
    chunks: [
      'Cắt tóc nam giá 120.000 VND, thợ 3 năm kinh nghiệm, gội đầu kèm.',
      'Cắt tóc nữ + gội giá 250.000 VND, tặng massage đầu 15 phút.',
      'Nhuộm tóc nữ thương hiệu Loreal giá 890.000 VND, bao dưỡng 1 tháng.',
      'Uốn tóc xoăn lọn giá 1.290.000 VND, thuốc uốn Nhật Bản.',
      'Duỗi tóc thẳng giá 990.000 VND, giữ form 6 tháng trở lên.',
      'Gym membership tháng giá 500.000 VND, 24/7 phòng tập có máy mới.',
      'Gym quý (3 tháng) giá 1.290.000 VND, tặng 1 buổi PT khởi động.',
      'Yoga class nhóm 8 buổi giá 890.000 VND, 2 buổi/tuần.',
      'Personal trainer 10 buổi giá 3.500.000 VND, 1-1 với HLV có chứng chỉ.',
      'Zumba fitness 12 buổi giá 790.000 VND, 3 buổi/tuần tối.',
      'Giặt ủi theo kg giá 35.000 VND/kg, trả trong 24h.',
      'Giặt ủi express 3 giờ giá 60.000 VND/kg, ưu tiên xử lý.',
      'Giặt khô comple/vest giá 150.000 VND/bộ, bảo hành form.',
      'Giặt chăn ga gối nệm king size giá 220.000 VND/bộ.',
      'Giặt giày thể thao giá 80.000 VND/đôi, tẩy vết bẩn.',
      'Massage body 60 phút giá 450.000 VND, tinh dầu tràm trà.',
      'Massage foot 60 phút giá 280.000 VND, giảm stress đau chân.',
      'Làm móng tay gel giá 350.000 VND, 30 màu chọn, giữ 3 tuần.',
      'Làm móng chân giá 250.000 VND, kèm massage chân 15 phút.',
      'Phun xăm chân mày combo giá 3.990.000 VND, bảo hành 1 năm.',
    ],
  },
  {
    id: 'education', label: 'Sách & giáo dục',
    chunks: [
      'Sách Atomic Habits bản tiếng Việt giá 189.000 VND, bản bìa cứng.',
      'Sách Sapiens Lược sử loài người giá 289.000 VND, bản bìa mềm dày 500 trang.',
      'Khóa học IELTS online 40 buổi giá 4.990.000 VND, cam kết 6.5+.',
      'Khóa TOEIC 20 buổi offline giá 2.990.000 VND, cam kết 600+.',
      'Sách Đắc nhân tâm giá 99.000 VND, bìa mềm tái bản 2024.',
      'Bộ sách giáo khoa lớp 1 giá 450.000 VND, đủ 12 môn.',
      'Từ điển Oxford Anh-Anh-Việt giá 690.000 VND, bìa cứng 1500 trang.',
      'Khóa tiếng Trung HSK 3 giá 3.290.000 VND, 30 buổi giảng viên Trung.',
      'Sách luyện thi đại học toán 12 giá 180.000 VND, kèm đề thi 5 năm.',
      'Khóa lập trình Python 20 buổi giá 2.490.000 VND, cho người mới.',
      'Khóa data science 30 buổi giá 5.990.000 VND, cam kết dự án thực tế.',
      'Sách Think Fast and Slow giá 259.000 VND, Daniel Kahneman.',
      'Khóa tiếng Nhật N4 40 buổi giá 3.990.000 VND, giảng viên bản xứ.',
      'Sách Dám nghĩ lớn giá 139.000 VND, David Schwartz.',
      'Khóa thiết kế Figma 15 buổi giá 1.990.000 VND, từ cơ bản đến nâng cao.',
      'Bộ từ vựng IELTS 3500 từ giá 220.000 VND, kèm audio online.',
      'Sách mindset tỷ phú giá 159.000 VND, tiểu sử 10 doanh nhân thế giới.',
      'Khóa Excel VBA 20 buổi giá 2.290.000 VND, cho kế toán office.',
      'Sách giải toán lớp 9 giá 120.000 VND, bám sát chương trình mới.',
      'Khóa marketing Facebook Ads giá 3.490.000 VND, 25 buổi kèm case study.',
    ],
  },
  {
    id: 'grocery', label: 'Siêu thị & thực phẩm',
    chunks: [
      'Gạo ST25 túi 5kg giá 185.000 VND, hạt dài thơm tự nhiên.',
      'Dầu ăn Simply đậu nành 2 lít giá 98.000 VND, nhập khẩu.',
      'Đường cát trắng Biên Hoà 1kg giá 28.000 VND, đóng gói chuẩn.',
      'Mì gói Hảo Hảo thùng 30 gói giá 145.000 VND, tôm chua cay.',
      'Sữa tươi TH True Milk 1 lít giá 42.000 VND, ít đường.',
      'Trứng gà ta hộp 10 quả giá 55.000 VND, gà nuôi thả vườn.',
      'Thịt heo ba chỉ 500g giá 95.000 VND, nguồn trại CP.',
      'Cá hồi Nauy fillet 500g giá 389.000 VND, đông lạnh nhập khẩu.',
      'Rau cải ngọt hữu cơ 500g giá 35.000 VND, Đà Lạt sạch VietGAP.',
      'Hoa quả combo 5kg giá 320.000 VND: cam, táo, nho, chuối, xoài.',
      'Nước tương Chinsu chai 500ml giá 32.000 VND, đậm đà.',
      'Nước mắm Phú Quốc Red Boat 500ml giá 125.000 VND, 40 độ đạm.',
      'Bia Heineken thùng 24 lon giá 420.000 VND, nhập Hà Lan.',
      'Coca Cola thùng 24 lon giá 220.000 VND, 330ml/lon.',
      'Bánh Oreo hộp 300g giá 65.000 VND, vị vanilla cream.',
      'Mỳ Ý spaghetti Barilla 500g giá 75.000 VND, Ý chính hãng.',
      'Sô cô la Toblerone 360g giá 189.000 VND, Thuỵ Sĩ nhập khẩu.',
      'Phô mai Cheddar Anchor 250g giá 145.000 VND, New Zealand.',
      'Cà phê G7 3in1 hộp 20 gói giá 78.000 VND, Trung Nguyên.',
      'Combo siêu thị gia đình 1 triệu VND gồm 20+ món thiết yếu.',
    ],
  },
  {
    id: 'auto', label: 'Xe máy & ô tô',
    chunks: [
      'Honda Wave Alpha 110cc giá 18.500.000 VND, phanh đĩa trước.',
      'Honda Future 125 giá 32.500.000 VND, tiết kiệm xăng 1.8L/100km.',
      'Yamaha Exciter 155 VVA giá 49.900.000 VND, thể thao ABS.',
      'Honda Vision 125 giá 32.500.000 VND, ABS, dành cho nữ.',
      'Honda SH Mode 125 giá 62.000.000 VND, phanh ABS khoá thông minh.',
      'Honda SH 160i bản cao cấp giá 108.000.000 VND, smartkey.',
      'Yamaha Grande Hybrid giá 49.500.000 VND, hybrid tiết kiệm xăng.',
      'Piaggio Liberty 150 giá 75.000.000 VND, Ý thiết kế cao cấp.',
      'VinFast Klara S giá 42.000.000 VND, xe máy điện 120km/lần sạc.',
      'Dầu nhớt Castrol Power 1 4T 1 lít giá 220.000 VND, tổng hợp.',
      'Ắc quy Yuasa MF 12V-4Ah giá 550.000 VND, cho xe tay ga.',
      'Lốp IRC xe SH 100/80-14 giá 680.000 VND, không săm.',
      'Dịch vụ bảo dưỡng xe máy định kỳ giá 350.000 VND, thay nhớt + vệ sinh.',
      'Thay dầu máy xe tay ga giá 220.000 VND, dầu Castrol chính hãng.',
      'Rửa xe máy giá 30.000 VND, kèm lau xích và bơm hơi miễn phí.',
      'Toyota Vios 1.5G CVT 2024 giá 555 triệu, 5 chỗ.',
      'Honda City RS 1.5 CVT 2024 giá 599 triệu, sedan.',
      'Mazda CX-5 2.0 Luxury 2024 giá 839 triệu, SUV 5 chỗ.',
      'Kia Seltos Premium 2024 giá 729 triệu, SUV đô thị.',
      'Dịch vụ lắp cảm biến áp suất lốp ô tô giá 2.500.000 VND, 4 van.',
    ],
  },
  {
    id: 'pharmacy', label: 'Nhà thuốc & y tế',
    chunks: [
      'Paracetamol 500mg hộp 100 viên giá 45.000 VND, giảm đau hạ sốt.',
      'Vitamin C 1000mg hộp 60 viên giá 250.000 VND, tăng đề kháng.',
      'Dầu gió Kwan Loong chai 57ml giá 75.000 VND, giảm đau nhức.',
      'Khẩu trang y tế 4 lớp hộp 50 cái giá 55.000 VND, kháng khuẩn.',
      'Gel rửa tay khô Lifebuoy 250ml giá 58.000 VND, diệt khuẩn 99.9%.',
      'Nhiệt kế điện tử Omron MC-246 giá 220.000 VND, đo 10 giây.',
      'Máy đo huyết áp Omron HEM-7121 giá 1.290.000 VND, bắp tay.',
      'Que thử thai Quickstick 1 que giá 25.000 VND, kết quả 3 phút.',
      'Vitamin tổng hợp Centrum 100 viên giá 890.000 VND, Mỹ nhập khẩu.',
      'Siro ho Prospan 100ml giá 125.000 VND, chiết xuất lá thường xuân.',
      'Men vi sinh Enterogermina 10 ống giá 110.000 VND, rối loạn tiêu hoá.',
      'Bông y tế Bạch Tuyết 1 gói 100g giá 30.000 VND, tiệt trùng.',
      'Băng keo cá nhân Urgo 1 hộp 100 miếng giá 65.000 VND.',
      'Dầu xoa Con ó 24ml giá 45.000 VND, giảm ho giải cảm.',
      'Thuốc nhỏ mắt V Rohto 13ml giá 45.000 VND, Nhật Bản.',
      'Kem bôi ngoài da Hydrocortisone 1% 15g giá 85.000 VND, kháng viêm.',
      'Sữa tắm Sebamed pH 5.5 200ml giá 195.000 VND, da nhạy cảm.',
      'Miếng dán hạ sốt Cool Fever hộp 6 miếng giá 95.000 VND, hạ nhiệt.',
      'Băng gạc y tế 10 cuộn giá 45.000 VND, khổ 10cm.',
      'Combo sơ cứu gia đình giá 290.000 VND, 15+ món cơ bản.',
    ],
  },
];

// ---------- build chunks ----------
const chunks = [];
let nextId = 1;
// Map industryId → array of chunk IDs (for query generation)
const idByIndustry = {};
for (const ind of industries) {
  idByIndustry[ind.id] = [];
  for (const text of ind.chunks) {
    const id = nextId++;
    idByIndustry[ind.id].push(id);
    chunks.push({ id, text, industry: ind.id });
  }
}

// ---------- query generators per category ----------
// Each generator returns { q, expected[], note } lists for 1 industry × N queries.
// We aim for 10 queries × 10 categories × 10 industries = 1000 queries.

function ranItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Pull a "salient noun" from a chunk (first common noun-like token chain).
// Crude: take first 2-3 words after stripping leading qualifier.
function salientNoun(text) {
  const clean = text.replace(/^[A-Za-zÀ-ỹ]+\s+/, ''); // strip first word
  return clean.split(/[\s.,]/).slice(0, 2).join(' ').trim();
}

// --- TYPO: drop last letter of a noun, mis-stem ---
function genTypo(industryId) {
  const chunkIds = idByIndustry[industryId];
  const out = [];
  for (let i = 0; i < 10; i++) {
    const id = chunkIds[i % chunkIds.length];
    const chunk = chunks.find(c => c.id === id);
    const noun = salientNoun(chunk.text);
    const q = typo(lowerVi(noun)).replace(/\s+/g, ' ') + ' gia bao nhiu';
    out.push({ q, expected: [id], note: 'typo' });
  }
  return out;
}

// --- NO-DIACRITIC: strip diacritics from a real phrase in the chunk ---
function genNoDiacritic(industryId) {
  const chunkIds = idByIndustry[industryId];
  const out = [];
  const templates = [
    t => `${t} gia bao nhieu`,
    t => `co ${t} khong`,
    t => `${t} con khong`,
    t => `${t} o dau ban`,
    t => `shop co ${t} khong shop oi`,
  ];
  for (let i = 0; i < 10; i++) {
    const id = chunkIds[i % chunkIds.length];
    const chunk = chunks.find(c => c.id === id);
    const noun = salientNoun(chunk.text);
    const q = templates[i % templates.length](lowerVi(noun));
    out.push({ q, expected: [id], note: 'no-diacritic' });
  }
  return out;
}

// --- NEGATION: "không phải X" → expect other chunks in same industry ---
function genNegation(industryId) {
  const chunkIds = idByIndustry[industryId];
  const out = [];
  for (let i = 0; i < 10; i++) {
    const excludeId = chunkIds[i % chunkIds.length];
    const excludeChunk = chunks.find(c => c.id === excludeId);
    const excludeNoun = salientNoun(excludeChunk.text);
    const expected = chunkIds.filter(cid => cid !== excludeId).slice(0, 5);
    out.push({
      q: `có ${lowerVi(excludeNoun).split(' ')[0]} nào khác không phải ${excludeNoun}`,
      expected,
      note: 'negation',
    });
  }
  return out;
}

// --- NUMBER-RANGE: "dưới X triệu" → expect chunks with price matching range ---
function genNumberRange(industryId) {
  const chunkIds = idByIndustry[industryId];
  const prices = chunkIds.map(id => {
    const chunk = chunks.find(c => c.id === id);
    // Extract price from chunk (crude: first multi-digit number)
    const m = chunk.text.match(/([\d.]+)(\.000)?\s*VND/);
    if (!m) return { id, price: null };
    const raw = m[1].replace(/\./g, '');
    return { id, price: parseInt(raw, 10) };
  }).filter(x => x.price !== null);

  const out = [];
  // 5 "dưới" queries + 5 "trên" queries
  const thresholds = [];
  if (prices.length >= 2) {
    const sorted = prices.map(x => x.price).sort((a, b) => a - b);
    const low = sorted[Math.floor(sorted.length * 0.3)];
    const mid = sorted[Math.floor(sorted.length * 0.5)];
    const high = sorted[Math.floor(sorted.length * 0.7)];
    thresholds.push(low, mid, high);
  }
  for (let i = 0; i < 10; i++) {
    if (prices.length < 3) break;
    const t = thresholds[i % thresholds.length];
    const isUnder = i % 2 === 0;
    const expected = prices.filter(p => isUnder ? p.price <= t : p.price >= t).map(p => p.id).slice(0, 5);
    if (expected.length === 0) continue;
    const qShort = t > 1_000_000 ? `${Math.round(t / 1_000_000)} triệu` : `${Math.round(t / 1000)}k`;
    out.push({
      q: `${isUnder ? 'dưới' : 'trên'} ${qShort} có gì`,
      expected,
      note: 'number-range',
    });
  }
  // Pad with generic if needed
  while (out.length < 10) out.push({ q: 'giá rẻ', expected: chunkIds.slice(0, 3), note: 'number-range' });
  return out.slice(0, 10);
}

// --- COMPARISON: "X với Y cái nào tốt hơn" ---
function genComparison(industryId) {
  const chunkIds = idByIndustry[industryId];
  const out = [];
  for (let i = 0; i < 10; i++) {
    const aId = chunkIds[i % chunkIds.length];
    const bId = chunkIds[(i + 3) % chunkIds.length];
    const a = chunks.find(c => c.id === aId);
    const b = chunks.find(c => c.id === bId);
    const aWord = salientNoun(a.text).split(' ')[0];
    const bWord = salientNoun(b.text).split(' ')[0];
    out.push({
      q: `${aWord} với ${bWord} cái nào tốt hơn`,
      expected: [aId, bId],
      note: 'comparison',
    });
  }
  return out;
}

// --- SHORT: single keyword ---
function genShort(industryId) {
  const chunkIds = idByIndustry[industryId];
  const out = [];
  for (let i = 0; i < 10; i++) {
    const id = chunkIds[i % chunkIds.length];
    const chunk = chunks.find(c => c.id === id);
    const noun = salientNoun(chunk.text).split(' ')[0];
    out.push({ q: noun, expected: [id], note: 'short' });
  }
  return out;
}

// --- ENG-MIX: Vietnamese query with English keyword ---
function genEngMix(industryId) {
  const chunkIds = idByIndustry[industryId];
  const out = [];
  const engKeywords = {
    phone: ['smartphone', 'camera', 'chip', 'waterproof', 'zoom', 'battery', 'flagship', 'gaming', 'charger', 'storage'],
    fashion: ['size', 'slim fit', 'cotton', 'material', 'outfit', 'vintage', 'streetwear', 'collection', 'brand', 'design'],
    fnb: ['latte', 'caffeine', 'combo', 'happy hour', 'vegan', 'dessert', 'espresso', 'brunch', 'delivery', 'special'],
    beauty: ['skincare', 'serum', 'spf', 'anti-aging', 'makeup', 'fragrance', 'moisturizer', 'foundation', 'vitamin', 'cleanser'],
    realestate: ['view', 'square meter', 'condo', 'penthouse', 'villa', 'location', 'floor', 'balcony', 'garden', 'investment'],
    service: ['membership', 'session', 'trainer', 'express', 'package', 'service', 'spa', 'class', 'combo', 'premium'],
    education: ['IELTS', 'TOEIC', 'online course', 'textbook', 'Python', 'beginner', 'certificate', 'study', 'tutor', 'learning'],
    grocery: ['organic', 'imported', 'fresh', 'combo', 'premium', 'ingredients', 'healthy', 'brand', 'snack', 'drink'],
    auto: ['ABS', 'smartkey', 'fuel', 'hybrid', 'CVT', 'SUV', 'sedan', 'maintenance', 'electric', 'engine'],
    pharmacy: ['vitamin', 'supplement', 'sanitizer', 'medicine', 'first aid', 'baby', 'skincare', 'tablet', 'syrup', 'mask'],
  };
  const keys = engKeywords[industryId] || ['product', 'price', 'quality', 'review', 'brand'];
  for (let i = 0; i < 10; i++) {
    const id = chunkIds[i % chunkIds.length];
    const k = keys[i % keys.length];
    out.push({ q: `shop có ${k} không`, expected: [id], note: 'eng-mix' });
  }
  return out;
}

// --- BRAND-ONLY: bare brand/product name ---
function genBrandOnly(industryId) {
  const chunkIds = idByIndustry[industryId];
  const out = [];
  for (let i = 0; i < 10; i++) {
    const id = chunkIds[i % chunkIds.length];
    const chunk = chunks.find(c => c.id === id);
    const firstTwo = chunk.text.split(/\s+/).slice(0, 2).join(' ');
    out.push({ q: firstTwo, expected: [id], note: 'brand-only' });
  }
  return out;
}

// --- OOD: totally unrelated ---
function genOOD(industryId) {
  const oods = [
    'thời tiết hôm nay ra sao', 'lịch âm tháng này', 'cách làm bánh flan', 'dạy tiếng Tây Ban Nha',
    'giá vàng hôm nay', 'bán máy cày ruộng không', 'thu cũ đổi mới iphone',
    'công thức nấu phở', 'cài win 11', 'dự báo chứng khoán',
    'shop có bán hoa tươi không', 'cho thuê xe tải', 'lắp camera an ninh',
    'làm visa du học mỹ', 'mua đất nền đà lạt',
  ];
  const out = [];
  for (let i = 0; i < 10; i++) {
    out.push({ q: oods[(i + industryId.length) % oods.length], expected: [], note: 'OOD' });
  }
  return out;
}

// --- COMPOUND: multiple intents ---
function genCompound(industryId) {
  const chunkIds = idByIndustry[industryId];
  const out = [];
  for (let i = 0; i < 10; i++) {
    const aId = chunkIds[i % chunkIds.length];
    const bId = chunkIds[(i + 5) % chunkIds.length];
    const a = chunks.find(c => c.id === aId);
    const b = chunks.find(c => c.id === bId);
    const aNoun = salientNoun(a.text).split(' ')[0];
    const bNoun = salientNoun(b.text).split(' ')[0];
    out.push({
      q: `${aNoun} và ${bNoun} có cùng giá không`,
      expected: [aId, bId],
      note: 'compound',
    });
  }
  return out;
}

// ---------- build queries ----------
const queries = [];
const generators = [genTypo, genNoDiacritic, genNegation, genNumberRange, genComparison, genShort, genEngMix, genBrandOnly, genOOD, genCompound];
for (const gen of generators) {
  for (const ind of industries) {
    queries.push(...gen(ind.id));
  }
}

// ---------- write ----------
const outPath = path.join(__dirname, '..', 'test-fixtures', 'rag-canonical-1000.json');
fs.writeFileSync(outPath, JSON.stringify({ chunks, queries }, null, 2));
console.log(`[gen] wrote ${chunks.length} chunks + ${queries.length} queries → ${outPath}`);
const cats = {};
for (const q of queries) cats[q.note] = (cats[q.note] || 0) + 1;
console.log('[gen] category breakdown:', cats);
const inds = {};
for (const c of chunks) inds[c.industry] = (inds[c.industry] || 0) + 1;
console.log('[gen] industry breakdown:', inds);
