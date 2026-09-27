# KSmart Scan

Công cụ quét mạng LAN, phát hiện camera IP và xem trực tiếp camera Hikvision trên trình duyệt.

![KSmart Scan](ksmart.png)

## Có gì trong dự án?

- Quét thiết bị trong dải mạng LAN bằng `arp-scan`, `nmap` hoặc `ping`.
- Nhận diện Hikvision qua ISAPI và RTSP, không cần mật khẩu ở bước phát hiện.
- Xác thực tài khoản bằng HTTP Digest và lưu credential bằng AES-256-GCM.
- Xem RTSP trên trình duyệt qua WebSocket + fragmented MP4/MSE.
- Hỗ trợ H.264, tự transcode H.265 sang H.264 khi cần.
- Theo dõi tiến trình quét theo thời gian thực.
- Hỗ trợ nhiều kênh NVR/DVR, snapshot, luồng chính và luồng phụ.

## Yêu cầu

- Node.js 18 trở lên
- `ffmpeg` và `ffprobe`
- `nmap` (khuyến nghị, không bắt buộc)
- `arp-scan` (tùy chọn, cần quyền phù hợp)

## Cài đặt và chạy

```bash
npm install
npm start
```

Mở <http://127.0.0.1:3000> trên trình duyệt.

Để chạy bộ test với camera giả:

```bash
npm test
```

## Luồng hoạt động

```text
Trình duyệt --WebSocket--> Node.js --RTSP--> Camera
     MSE   <-- fMP4 -----  ffmpeg
```

1. Chọn card mạng và dải IP cần quét.
2. Bắt đầu quét để phát hiện thiết bị.
3. Nhập tài khoản camera khi muốn xem video.
4. Chọn kênh và luồng chính/phụ trong cửa sổ xem.

## Tài liệu

- [Hướng dẫn sử dụng Windows](USER_GUIDE.md)
- [Chi tiết kỹ thuật, API, cấu hình và xử lý sự cố](docs/TECHNICAL_DETAILS.md)

## Bảo mật

Chỉ quét mạng và truy cập những thiết bị bạn có quyền quản lý. Mặc định server chỉ lắng nghe trên `127.0.0.1`. Nếu dùng `HOST=0.0.0.0`, hãy đặt thêm lớp xác thực hoặc reverse proxy.

Credential được mã hóa bằng AES-256-GCM. Không commit file `.env`, khóa mã hóa hoặc dữ liệu trong thư mục `data/`.

## Giới hạn hiện tại

- Chưa hỗ trợ audio.
- H.265 cần transcode nên sử dụng CPU nhiều hơn H.264.
- Safari/iOS có thể không phát được fMP4 qua MSE.
- Độ trễ phụ thuộc đáng kể vào khoảng cách giữa các I-frame của camera.

## Giấy phép và phạm vi sử dụng

Dự án phục vụ mục đích quản trị thiết bị trong mạng được cấp quyền. Hãy tuân thủ chính sách bảo mật và pháp luật áp dụng tại môi trường sử dụng.
