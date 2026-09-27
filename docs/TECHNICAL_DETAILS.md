# Chi tiết kỹ thuật

Tài liệu này chứa thông tin triển khai chi tiết được tách khỏi README chính.

## Kiến trúc

```text
Browser ── WebSocket ──> Node.js ── RTSP ──> Camera Hikvision
   MSE  <── fMP4 ─────── ffmpeg
```

## Phát hiện thiết bị

| Thành phần | Vai trò |
|---|---|
| `server/lib/discovery.js` | Tìm host sống bằng `arp-scan`, `nmap` hoặc `ping` |
| `server/lib/network.js` | Liệt kê card mạng, tính CIDR và giới hạn dải quét |
| `server/lib/portscan.js` | Dò cổng bằng TCP connect, không cần root |
| `server/lib/oui.js` | Gợi ý hãng theo 3 byte đầu của MAC |
| `server/lib/rtsp.js` | Bắt tay RTSP `OPTIONS` và `DESCRIBE` |
| `server/lib/hikvision.js` | Xác nhận qua endpoint ISAPI |
| `server/lib/scanner.js` | Điều phối quét và phát sự kiện real-time |

Thiết bị được phân loại thành `hikvision`, `camera` hoặc `normal`. OUI chỉ là gợi ý; kết luận chính xác dựa trên ISAPI và RTSP.

## Credential và xác thực

- `server/lib/credentials.js` lưu tài khoản bằng AES-256-GCM.
- Khóa lấy từ `CRED_KEY` hoặc file `data/.cred.key`.
- Tài khoản được kiểm tra qua ISAPI và RTSP trước khi lưu.
- Mật khẩu không xuất hiện trong response API hoặc log.
- ISAPI thất bại không chặn phát video nếu RTSP vẫn xác thực thành công.

## Phát video

`server/lib/stream.js` quản lý process ffmpeg và phiên xem. `server/lib/mp4.js` tách stdout thành init segment và media segment cho MSE.

- H.264 được copy trực tiếp để giảm CPU.
- H.265 được transcode sang H.264 bằng `libx264`.
- Nhiều người xem cùng camera dùng chung một process ffmpeg.
- Process tự dừng sau thời gian không còn người xem.
- Client chậm sẽ bị drop segment để tránh nghẽn bộ nhớ.
- Có thể buộc transcode bằng `transcode=1` trên WebSocket stream.

## API

| Method | Endpoint | Mô tả |
|---|---|---|
| GET | `/api/interfaces` | Danh sách card mạng và dải quét gợi ý |
| POST | `/api/scan` | Bắt đầu quét `{cidr, ports, iface}` |
| POST | `/api/scan/:id/cancel` | Hủy một lượt quét |
| GET | `/api/devices` | Danh sách thiết bị đã tìm thấy |
| POST | `/api/devices/:ip/credentials` | Xác thực và lưu tài khoản |
| DELETE | `/api/devices/:ip/credentials` | Xóa tài khoản đã lưu |
| GET | `/api/devices/:ip/channels` | Lấy danh sách kênh |
| GET | `/api/devices/:ip/snapshot?channel=101` | Lấy ảnh JPEG |
| GET | `/api/streams` | Danh sách luồng đang phát |
| WS | `/ws/events` | Sự kiện quét real-time |
| WS | `/ws/stream?ip=&channel=&stream=&transcode=` | Luồng fMP4 |

## Biến môi trường

```bash
HOST=127.0.0.1
PORT=3000
SCAN_PORTS=554,8000,80,443,8080,8554,2020,37777
PORT_TIMEOUT=900
HOST_CONCURRENCY=64
MAX_HOSTS=4096
USE_ARP_SCAN=1
FRAG_DURATION=400000
STREAM_IDLE_TIMEOUT=8000
MAX_STREAM_SESSIONS=8
TRANSCODE_BITRATE=2000k
CRED_KEY=<64 ký tự hex>
```

`USE_ARP_SCAN=1` cần `arp-scan` và quyền hệ thống phù hợp. Không đặt server ra ngoài mạng nội bộ nếu chưa có lớp xác thực.

## Kiểm tra credential bị từ chối

Trước tiên kiểm tra camera có yêu cầu HTTP Digest không:

```bash
curl -s -D- -o /dev/null http://<IP-CAMERA>/ISAPI/System/deviceInfo | grep -i www-authenticate
```

Sau đó thử độc lập bằng `curl`:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  --digest -u 'admin:MAT_KHAU' \
  http://<IP-CAMERA>/ISAPI/System/deviceInfo
```

Có thể dùng công cụ kiểm tra đi kèm:

```bash
npm run check -- 192.168.100.53 admin 'MAT_KHAU_THAT'
```

Hikvision thường khóa tài khoản sau nhiều lần đăng nhập sai. Khi đó hãy chờ thời gian khóa kết thúc trước khi thử lại.

Nếu mật khẩu xuất hiện trong URL RTSP ở dạng mã hóa, hãy giải mã trước khi nhập vào form:

```bash
node -e "console.log(decodeURIComponent('Vpp%40921%21'))"
```

## Độ trễ và giới hạn

Độ trễ phụ thuộc nhiều vào I-frame interval của camera. Dùng sub stream khi xem nhiều camera cùng lúc.

- Không có audio.
- H.265 cần transcode và có thể dùng nhiều CPU.
- Safari/iOS có thể không hỗ trợ fMP4 qua MSE.
- Bảng OUI không đầy đủ và chỉ dùng để gợi ý.

## Cấu trúc chính

```text
server/
  index.js                 REST, WebSocket và vòng đời phiên xem
  config.js                Cấu hình từ biến môi trường
  lib/                     Discovery, credential, RTSP và streaming
public/
  index.html               Giao diện dashboard
  styles.css               Giao diện
  app.js                   Quét và điều khiển UI
  player.js                MSE player
 test/
  fake-camera.js           Camera giả RTSP + ISAPI
  e2e.js                   Bộ test đầu-cuối
 tools/
  check-credential.js      Kiểm tra tài khoản camera
```
