# HƯỚNG DẪN SỬ DỤNG PHẦN MỀM KSMART SCAN
### Công cụ Dò tìm Camera IP & Xem trực tiếp trên Máy tính Windows

---

## ⚠️ LƯU Ý QUAN TRỌNG TRƯỚC KHÍ SỬ DỤNG

1. **Kết nối chung mạng (LAN / Wi-Fi):**
   * Máy tính chạy phần mềm và các Camera/Đầu ghi **bắt buộc phải kết nối chung một mạng LAN** (chung Wi-Fi hoặc cắm chung dây mạng vào cùng một Router/Switch).
   * Nếu máy tính và camera ở 2 lớp mạng khác nhau (không thông lớp IP), ứng dụng sẽ không thể dò thấy camera.

2. **Cấu trúc bộ phần mềm (Dành riêng cho Windows):**
   * Thư mục phần mềm giải nén ra bao gồm **3 file bắt buộc** nằm chung với nhau:
     * `KSmartscan.exe` — File chạy ứng dụng chính.
     * `ffmpeg.exe` — Engine giải mã luồng video camera.
     * `ffprobe.exe` — Engine đọc thông tin kỹ thuật video.
   * **Lưu ý hệ điều hành:** Bộ 3 file này (bao gồm 2 file `.exe` của FFmpeg) **chỉ dành riêng cho hệ điều hành Windows**. Không thể copy trực tiếp các file `.exe` này sang máy chạy macOS hay Ubuntu/Linux để mở.

---

## 📖 HƯỚNG DẪN CÁC BƯỚC SỬ DỤNG

### Bước 1: Khởi chạy phần mềm
* Mở thư mục chứa phần mềm và nhấp đôi chuột vào file **`KSmartscan.exe`**.
* Giao diện ứng dụng sẽ mở ra lập tức.

---

### Bước 2: Quét dò tìm Camera trong mạng
1. **Card mạng:** Phần mềm tự động chọn Card mạng đang hoạt động (Wi-Fi hoặc Ethernet). Nếu máy tính có nhiều Card mạng, hãy chọn đúng Card mạng đang nối với hệ thống camera.
2. **Hãng Camera:** Mặc định chọn **Hikvision**.
3. **Cổng cần dò:** Mặc định là các cổng tiêu chuẩn (`80,554,8000,8080,37777,34567,8554,443`). Bạn có thể giữ nguyên.
4. Nhấn nút **`Bắt đầu quét`**.

---

### Bước 3: Đọc bảng kết quả & Thống kê
Phần mềm sẽ tự động dò và phân loại thiết bị vào 4 ô thống kê:
* **Thiết bị:** Tổng số thiết bị đang hoạt động phát hiện được trong mạng.
* **Hikvision:** Số lượng Camera / Đầu ghi được xác định chính xác 100% là hãng Hikvision.
* **Nghi ngờ camera:** Số lượng camera của các hãng khác (Dahua, Imou, Ezviz, Uniview...) hoặc thiết bị có mở cổng xem video.
* **Thiết bị thường:** Các thiết bị mạng khác (PC, Router, TV, Máy in...).

---

### Bước 4: Nhập tài khoản & Xem Camera
1. Tìm thiết bị camera cần xem trong danh sách, nhấn nút **`Kết nối`** (hoặc **`Xem`**).
2. Cửa sổ nhập tài khoản xuất hiện:
   * **Tên đăng nhập:** Mặc định là `admin`.
   * **Mật khẩu:** Nhập mật khẩu của Camera / Đầu ghi Hikvision của bạn.
   * *(Tùy chọn)* Tích chọn **Ghi nhớ** để lần sau không cần nhập lại mật khẩu.
3. Nhấn **`Kết nối`**.

---

### Bước 5: Thao tác trong màn hình xem Video trực tiếp
Khi kết nối thành công, màn hình xem trực tiếp (Liveview) sẽ mở ra:
* **Đổi kênh (với Đầu ghi NVR/DVR):** Nếu kết nối vào Đầu ghi có nhiều mắt camera, bấm vào ô **Kênh** để chọn mắt camera muốn xem (ví dụ: *Kênh 1 - VP001*, *Kênh 2*, *Kênh 3*...).
* **Chuyển đổi Luồng chính / Luồng phụ:**
  * **Luồng chính (Main Stream):** Cho hình ảnh nét cao (Full HD/4K).
  * **Luồng phụ (Sub Stream):** Cho hình ảnh độ phân giải thấp hơn, xem mượt hơn và tốn ít dung lượng mạng.

---

## ❓ MỘT SỐ CÂU HỎI THƯỜNG GẶP (TROUBLESHOOTING)

* **Q: Tại sao quét xong không thấy camera nào?**
  * *Trả lời:* Kiểm tra lại xem máy tính đã bắt đúng Wi-Fi/mạng dây của hệ thống camera chưa.
* **Q: Bấm "Xem" bị báo lỗi mật khẩu hoặc không lên hình?**
  * *Trả lời:* Kiểm tra lại mật khẩu camera đã nhập chính xác chưa. Nếu nhập sai, bấm nút **Sửa** ở dòng camera đó để nhập lại mật khẩu.
* **Q: Có thể copy thư mục phần mềm này gửi cho máy Windows khác dùng được không?**
  * *Trả lời:* Có! Bạn chỉ cần nén cả thư mục (gồm 3 file `KSmartscan.exe`, `ffmpeg.exe`, `ffprobe.exe`) thành file `.zip` rồi gửi cho máy Windows khác là chạy được ngay không cần cài đặt.
