# Kế hoạch chuyển đổi sang Native App (Tauri v2)

Mục tiêu: Chuyển đổi ứng dụng Web (đang chạy qua `backend-rust` và thư mục `public`) thành một ứng dụng Desktop Native hoàn chỉnh (chạy độc lập, có icon, cửa sổ riêng) bằng **Tauri v2**.

## Phân tích thắc mắc của bạn về việc Build App cho Windows trên Ubuntu

**Bạn đã hoàn toàn chính xác!** Việc Cross-compile (biên dịch chéo) một ứng dụng Tauri từ Ubuntu để chạy trên Windows là **cực kỳ khó khăn, nhiều lỗi và không được Tauri khuyến khích**. 
Nguyên nhân là do ứng dụng Windows yêu cầu các thư viện UI native của Windows (như WebView2, Win32 API, MSVC tools) - những thứ mà Linux không có sẵn hoặc không mô phỏng hoàn hảo được qua `mingw`.

> [!TIP]
> **Giải pháp:** Chúng ta sẽ **không** cố gắng build ra file `.exe` trực tiếp trên máy Ubuntu của bạn. Thay vào đó:
> 1. **Phát triển và Test trên Ubuntu:** Chúng ta vẫn sẽ dùng máy Ubuntu của bạn để code và chạy thử ứng dụng (nó sẽ chạy dưới dạng app Linux).
> 2. **Build ra `.exe` bằng GitHub Actions (Đề xuất):** Sau khi code xong, chúng ta chỉ cần đẩy code lên GitHub (hoặc dùng 1 file script cấu hình). Hệ thống máy chủ Windows của GitHub sẽ tự động build ứng dụng và trả về file `.exe` hoặc `.msi` cài đặt chuẩn cho Windows. Cách này miễn phí, tự động 100% và không bao giờ bị lỗi môi trường.

---

## 1. Phương án kiến trúc (Architecture)

Vì ứng dụng hiện tại đang sử dụng luồng WebSocket (để truyền video stream) và REST API khá phức tạp qua `axum`, cách tốt nhất và an toàn nhất để tích hợp Tauri là **Nhúng (Embed) trực tiếp Axum server vào Tauri**.

- **Frontend (Giao diện):** Tauri Webview sẽ nạp và hiển thị trực tiếp các file từ thư mục `public/`.
- **Backend (Lõi):** Khi ứng dụng Desktop khởi chạy, Tauri sẽ tự động chạy ngầm server `axum` (ở cổng 3000 hoặc một cổng ngẫu nhiên) để xử lý logic dò tìm IP và Stream video. Frontend sẽ kết nối với server ngầm này.
- **Tiện lợi:** Giữ nguyên được 100% logic hiện tại, không phải viết lại code WebSockets sang Tauri IPC (cực kỳ phức tạp cho video streaming).

## 2. Các bước thực hiện chi tiết

### Bước 2.1: Khởi tạo Tauri
- Khởi tạo thư mục `src-tauri` tại thư mục gốc.
- Cấu hình file `tauri.conf.json`:
  - `productName`: **Ksmart scan** (Lưu ý: Tôi giả định chữ "scam" là bạn gõ nhầm chữ "scan", nếu bạn muốn giữ đúng chữ "scam" xin báo lại nhé).
  - `frontendDist`: `../public`.

### Bước 2.2: Sát nhập mã nguồn Rust
- Dời toàn bộ code từ `backend-rust/` sang `src-tauri/src`.
- Cấu hình lại `main.rs` để Tauri chạy ngầm `axum` server trước khi mở giao diện.
- **Dọn dẹp:** Xóa thư mục `backend-rust` sau khi đã chuyển an toàn (như bạn đã đồng ý).

### Bước 2.3: Thiết lập Icon
- Sử dụng file ảnh **`ksmart.png`** (đã tìm thấy trong thư mục dự án) để làm icon chính. Tôi sẽ chuyển nó thành `app-icon.png` và dùng công cụ `tauri icon` để tạo ra đủ các kích thước cần thiết cho Windows, macOS và Linux.

### Bước 2.4: Thiết lập hệ thống Build (CI/CD)
- Viết một file cấu hình GitHub Actions (`.github/workflows/build-windows.yml`) hoặc hướng dẫn bạn mang code sang máy Windows để chạy lệnh `cargo tauri build` một cách đơn giản nhất, để lấy file `.exe`.


