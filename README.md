# find-ip-device — Dò tìm & xem Camera IP (Hikvision) trên web

Quét dải mạng LAN, định danh camera Hikvision, và xem trực tiếp video RTSP ngay trên trình duyệt.
Toàn bộ backend viết bằng **Node.js**, phần chuyển luồng video dùng **ffmpeg**.

```
Browser ──WebSocket──> Node.js ──RTSP──> Camera Hikvision
   MSE  <──fMP4───────  ffmpeg
```

## Yêu cầu

| Thành phần | Bắt buộc | Ghi chú |
|---|---|---|
| Node.js >= 18 | ✅ | Đã test trên v20.19 |
| ffmpeg + ffprobe | ✅ | `sudo apt install ffmpeg` |
| nmap | Nên có | Quét host nhanh hơn nhiều; không có thì tự fallback sang `ping` |
| arp-scan | Không | Chính xác nhất (thấy cả thiết bị chặn ping) nhưng cần `sudo NOPASSWD`. Không có nút trong UI — bật bằng `USE_ARP_SCAN=1` |

## Chạy

```bash
npm install
npm start
```

Mở http://127.0.0.1:3000

## 4 bước hệ thống — đã hiện thực ở đâu

### Bước 1 — Quét & định danh thiết bị

| Việc | File | Cách làm |
|---|---|---|
| Tìm host sống | [discovery.js](server/lib/discovery.js) | `arp-scan` (nếu bật) → `nmap -sn` → `ping` sweep. Sau đó lấy MAC từ `ip neigh` |
| Dò cổng | [portscan.js](server/lib/portscan.js) | TCP connect thuần Node, **không cần root** |
| Đoán hãng | [oui.js](server/lib/oui.js) | Tra 3 byte đầu MAC (OUI) — chỉ là *gợi ý* |
| Xác nhận RTSP | [rtsp.js](server/lib/rtsp.js) | Bắt tay `OPTIONS` + `DESCRIBE`, đọc header `Server` / `realm` |
| Xác nhận Hikvision | [hikvision.js](server/lib/hikvision.js) | Gọi `/ISAPI/System/deviceInfo`. **HTTP 401 với `realm="IP Camera(...)"` đã đủ để kết luận** — không cần mật khẩu |
| Điều phối + phát sự kiện | [scanner.js](server/lib/scanner.js) | `EventEmitter`, đẩy từng thiết bị lên UI ngay khi tìm thấy |

Thiết bị được chia 3 loại: `hikvision` / `camera` (nghi ngờ) / `normal`.

### Bước 2 — Cơ chế xác thực

[credentials.js](server/lib/credentials.js) + [digest.js](server/lib/digest.js)

- Popup nhập user/pass → `POST /api/devices/:ip/credentials`
- Server **xác thực thật trước khi lưu**, theo 2 đường độc lập:
  1. **ISAPI** (HTTP Digest) → lấy model, serial, firmware, danh sách kênh
  2. **RTSP** (ffprobe) → đây mới là điều kiện *thực sự* để xem được video
- Chỉ cần 1 trong 2 đường thành công là chấp nhận. Camera OEM/rebrand hay có ISAPI trả 401
  hoặc không đầy đủ, nhưng RTSP vẫn nhận đúng tài khoản — nên **ISAPI thất bại không chặn RTSP**
  (có test regression cho đúng ca này)
- Lưu bằng **AES-256-GCM**, khoá ở `data/.cred.key` (chmod 600) hoặc biến môi trường `CRED_KEY`
- Mật khẩu **không bao giờ** xuất hiện trong response API hay log (xem `maskUrl`)

HTTP Digest tự viết bằng `crypto` (~90 dòng) — không thêm dependency.

### Bước 3 — Chuyển đổi luồng video (lõi)

[stream.js](server/lib/stream.js) + [mp4.js](server/lib/mp4.js)

Chọn **fragmented MP4 qua WebSocket + MSE** thay vì WebRTC:

```
ffmpeg -rtsp_transport tcp -i rtsp://... \
       -an -c:v copy \
       -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset \
       -frag_duration 400000 pipe:1
```

- `mp4.js` tách stdout của ffmpeg thành **init segment** (`ftyp`+`moov`) và các **media segment** (`moof`+`mdat`) — đúng thứ tự MSE yêu cầu
- **Tự phát hiện codec**: `ffprobe` trước khi mở phiên
  - H.264 → `-c:v copy`, CPU gần như 0%
  - H.265 → transcode sang H.264 (`libx264 -tune zerolatency`), tốn ~1 core mỗi luồng
- **Buộc transcode** (`?transcode=1`): dùng khi trình duyệt không giải mã được luồng gốc dù
  là H.264 — gặp ở camera cấu hình profile lạ (4:4:4, High 4:2:2) hoặc bitstream có lỗi.
  Không có nút bật thủ công: khi player bắt được `PIPELINE_ERROR_DECODE`, UI **tự hiện** nút
  *"Thử lại với transcode"*. Hai chế độ là hai phiên riêng biệt (key có hậu tố `/tc`).
- **Dùng chung process**: nhiều người xem cùng 1 camera → 1 ffmpeg duy nhất
- **Tự dọn**: hết người xem → `SIGTERM` sau `STREAM_IDLE_TIMEOUT` (mặc định 8s)
- **Chống nghẽn**: client chậm (`bufferedAmount > 4MB`) thì drop segment, quá 50 lần thì ngắt

Client ([player.js](public/player.js)) đọc `avcC` trong init segment để dựng đúng codec string
(`avc1.42c01e`), rồi giữ con trỏ phát sát mép buffer để độ trễ không tích lũy.

### Bước 4 — UI/UX

[public/](public/) — không framework, không build step.

- Dashboard: card mạng, dải IP, 5 ô thống kê
- **Real-time**: `/ws/events` đẩy từng thiết bị lên bảng ngay khi dò ra (không chờ quét xong)
- Thanh tiến trình + một dòng trạng thái hiện thông báo mới nhất rồi tự ẩn
- Chuyển giao diện **sáng/tối**, nhớ lựa chọn trong `localStorage`, lần đầu theo `prefers-color-scheme`
- Bộ lọc Tất cả / Camera / Thiết bị thường
- Bảng gọn 5 cột; MAC, hãng và lý do phân loại nằm trong tooltip khi rê chuột lên IP
- Popup video: chọn kênh, đổi Luồng chính/Luồng phụ, xem thống kê (độ phân giải, codec, kbps, độ trễ)
- Nút **Ảnh chụp**: lấy thẳng khung hình đang phát bằng canvas rồi tải về JPEG. Không đi qua
  ISAPI (nhiều camera OEM trả 401) và không bắt camera encode thêm một ảnh nữa. Chỉ khi chưa
  có khung hình nào mới lùi về endpoint ISAPI `/api/devices/:ip/snapshot`

## Đã kiểm chứng những gì

| Hạng mục | Kết quả |
|---|---|
| Quét LAN thật (`192.168.100.0/24`) | 11 thiết bị trong 2.6s; camera Hikvision tại `192.168.100.53` được định danh đúng qua `realm="IP Camera(GT415)"` + RTSP handshake, **không cần mật khẩu** |
| Xác thực + lưu credential | ISAPI/RTSP probe chạy thật; mật khẩu không lọt ra API (`rtsp://admin:***@...`) |
| Luồng video trong Chrome | `avc1.42c01f` 1280x720, **651 frame decode, 0 corrupted**, độ trễ **0.01–0.29s** |
| Buộc transcode | 520 frame, 0 corrupted, độ trễ 0.08s, phiên riêng `/tc` |
| Dọn tài nguyên | Đóng cửa sổ xem → ffmpeg tự tắt, `/api/streams` về rỗng |
| Bộ test đầu-cuối | **18/18 pass** (`npm test`, dùng camera giả — không cần camera thật) |

## API

| Method | Endpoint | Việc |
|---|---|---|
| GET | `/api/interfaces` | Danh sách card mạng + dải quét gợi ý |
| POST | `/api/scan` | Bắt đầu quét `{cidr, ports, iface}` (thêm `useArpScan: true` để ép dùng arp-scan cho lần quét này) |
| POST | `/api/scan/:id/cancel` | Huỷ quét |
| GET | `/api/devices` | Thiết bị đã tìm thấy |
| POST | `/api/devices/:ip/credentials` | Xác thực + lưu tài khoản |
| DELETE | `/api/devices/:ip/credentials` | Xoá tài khoản |
| GET | `/api/devices/:ip/channels` | Danh sách kênh (NVR nhiều kênh) |
| GET | `/api/devices/:ip/snapshot?channel=101` | Ảnh JPEG |
| GET | `/api/streams` | Các luồng đang phát |
| WS | `/ws/events` | Sự kiện quét real-time |
| WS | `/ws/stream?ip=&channel=&stream=&transcode=` | Luồng fMP4 (`transcode=1` để buộc re-encode) |

## Cấu hình (biến môi trường)

```bash
HOST=127.0.0.1              # 0.0.0.0 nếu muốn máy khác truy cập
PORT=3000
SCAN_PORTS=554,8000,80,443,8080,8554,2020,37777
PORT_TIMEOUT=900            # ms chờ mỗi cổng
HOST_CONCURRENCY=64         # số host dò song song
MAX_HOSTS=4096              # chặn quét dải quá lớn
USE_ARP_SCAN=1              # bật arp-scan (cần sudo NOPASSWD); không có trong UI
FRAG_DURATION=400000        # µs — nhỏ hơn = trễ thấp hơn
STREAM_IDLE_TIMEOUT=8000
MAX_STREAM_SESSIONS=8
TRANSCODE_BITRATE=2000k     # chỉ dùng khi phải transcode H.265
CRED_KEY=<64 ký tự hex>     # khoá mã hoá; để trống sẽ tự sinh
```

## Chạy test (không cần camera thật)

```bash
npm test
```

`test/fake-camera.js` dựng một camera giả: RTSP server thật ở `rtsp://127.0.0.1:8554/live`
(ffmpeg sinh RTP, Node lo signaling + relay interleaved) kèm một ISAPI giả ở `:8081` luôn
trả 401. Bộ test đi qua đúng các REST endpoint và WebSocket mà trình duyệt gọi — 18 ca.

Muốn tự thử bằng tay thì chạy camera giả riêng: `npm run fake-camera`, rồi trong UI nhập
IP `127.0.0.1`, cổng RTSP `8554`, đường dẫn `/live`.

## Kiểm tra một trình duyệt / webview có xem được video không

Mở **`/check.html`**. Trang này nạp thật một đoạn fMP4 H.264 vào MSE rồi đếm số khung hình
giải mã được — không chỉ hỏi API có tồn tại hay không. Đây là điểm phân biệt quan trọng:
WebKitGTK báo `MediaSource: có` nhưng vẫn không giải mã nổi H.264.

Dùng để quyết định đóng gói native (Tauri/Electron) hoặc để hỗ trợ người dùng báo "không thấy hình".

Đã kiểm chứng hai chiều:

| Webview | Kết quả |
|---|---|
| Chrome / WebView2 (Windows) | ✅ PASS — 10 khung hình decode, 0 hỏng |
| WebKitGTK (Tauri trên Linux) | ❌ FAIL — `MediaSource: có` nhưng mọi codec H.264 đều `KHÔNG` |

Muốn thử từ máy khác (vd máy Mac) thì cho server lắng nghe ra LAN:

```bash
HOST=0.0.0.0 npm start
```

Rồi trên máy đó mở `http://<IP-máy-chạy-server>:3000/check.html`.

## Xử lý sự cố: báo "Sai tài khoản hoặc mật khẩu (HTTP 401)"

Kiểm tra theo đúng thứ tự này:

**1. Xác nhận camera đòi Digest và chưa bị khoá** — request này *không* gửi mật khẩu nên
không tính là một lần đăng nhập sai:

```bash
curl -s -D- -o /dev/null http://<IP-CAMERA>/ISAPI/System/deviceInfo | grep -i www-authenticate
```

Phải thấy `Digest ... realm="IP Camera(...)"` và `stale="FALSE"`.

**2. Thử mật khẩu bằng curl** — đây là bản tham chiếu chuẩn, tách biệt hoàn toàn khỏi code
của dự án. Nếu curl cũng 401 thì vấn đề là ở thông tin đăng nhập, không phải ở ứng dụng:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" --digest -u 'admin:MAT_KHAU' http://<IP-CAMERA>/ISAPI/System/deviceInfo
```

**⚠️ Hikvision khoá tài khoản sau 5 lần sai, mặc định 30 phút.** Khi đã bị khoá thì *mật khẩu
đúng cũng trả về 401* — nên đừng thử liên tục. Đợi 30 phút rồi thử lại đúng một lần.

**2b. Hoặc dùng công cụ có sẵn** — nó kiểm tra camera trước (không tốn lần thử), cảnh báo
nếu mật khẩu trông như đã bị URL-encode, hỏi xác nhận, rồi thử ISAPI + RTSP và in kết luận:

```bash
npm run check -- 192.168.100.53 admin 'MAT_KHAU_THAT'
```

**3. Coi chừng mật khẩu bị URL-encode.**

Đây là chỗ rất dễ sai. **ffmpeg, VLC và mọi RTSP client đều URL-decode phần userinfo trong
URL trước khi gửi đi** (đã kiểm chứng: `rtsp://admin:Ab%4012!@host/...` gửi lên mật khẩu
`Ab@12!`). Nghĩa là:

> Chuỗi mật khẩu trong một URL RTSP đang chạy **không phải** mật khẩu thật —
> nó là **dạng đã encode** của mật khẩu thật.

Nên nếu bạn copy đoạn đó dán vào form đăng nhập thì sẽ sai. Phải giải mã trước:

```bash
node -e "console.log(decodeURIComponent('Vpp%40921%21'))"
```

Bảng tra nhanh:

| Trong URL | Ký tự thật |
|---|---|
| `%40` | `@` |
| `%21` | `!` |
| `%23` | `#` |
| `%24` | `$` |
| `%26` | `&` |
| `%3A` | `:` |

Ví dụ `Vpp%40921%21` → nhập vào form là `Vpp@921!`. Form của ứng dụng nhận **mật khẩu thật**,
việc encode để đưa vào URL RTSP do server tự làm ([rtsp.js](server/lib/rtsp.js) —
`encodeURIComponent`, an toàn cả khi mật khẩu thật có chứa dấu `%`).

**Nếu URL chạy được trên máy khác mà form vẫn 401:** lấy đúng chuỗi trong URL đó, giải mã
bằng lệnh trên, rồi nhập kết quả vào form. Lưu ý `!` trong bash tương tác gây history
expansion — luôn bọc URL trong **nháy đơn**:

```bash
ffplay -rtsp_transport tcp 'rtsp://admin:Vpp%40921%21@192.168.100.53:554/Streaming/Channels/101'
```

**4. Nếu ISAPI 401 nhưng RTSP vẫn chạy** — ứng dụng vẫn cho qua và xem được video, chỉ là
không lấy được model/serial/danh sách kênh. Đây là hành vi có chủ ý.

## Giảm độ trễ

Độ trễ thực tế **phụ thuộc chủ yếu vào I-frame interval của camera**, không phải vào code.
Trên web quản trị Hikvision: *Configuration → Video/Audio → I Frame Interval*.

| I-frame interval | Độ trễ ước tính |
|---|---|
| 50 (mặc định, 2s) | 1.5 – 2.5s |
| 25 (= FPS, 1s) | 0.8 – 1.5s |
| 10 | 0.4 – 0.8s |

Thêm nữa: dùng **Sub stream** cho xem nhiều camera cùng lúc (nhẹ hơn nhiều).

## Giới hạn đã biết

- **Không có audio.** Camera thường dùng G.711, browser không phát trực tiếp được. Muốn có thì thêm `-c:a aac` và bỏ `-an`.
- **Safari / iOS không phát được** fMP4 qua MSE (chỉ hỗ trợ Managed Media Source từ iOS 17.1+). Dùng Chrome/Edge/Firefox.
- **H.265 phải transcode** → tốn CPU. 8 luồng H.265 cùng lúc sẽ nặng; hạ `MAX_STREAM_SESSIONS` hoặc dùng Sub stream (thường là H.264).
- **OUI lookup không đầy đủ.** Bảng trong `oui.js` chỉ có các dải phổ biến. Kết luận chính xác đến từ ISAPI probe, không phải từ MAC.
- **Cổng 8000 mở không chắc là Hikvision** — nhiều ứng dụng khác cũng dùng cổng này. Vì vậy nó chỉ xếp loại "nghi ngờ camera".

## Nếu cần độ trễ < 0.5s hoặc hỗ trợ Safari

Thay tầng media proxy bằng WebRTC. Cách gọn nhất là chạy [go2rtc](https://github.com/AlexxIT/go2rtc)
hoặc [MediaMTX](https://github.com/bluenviron/mediamtx) như một process phụ, rồi giữ nguyên
Scanner + Credential Manager của dự án này — chỉ đổi `stream.js` thành lớp gọi API của nó.

## Lưu ý

Công cụ này quét mạng và truy cập camera. Chỉ dùng trên **mạng và thiết bị bạn có quyền quản lý**.
Mặc định server chỉ bind `127.0.0.1`; nếu mở ra `0.0.0.0` thì nên đặt thêm reverse proxy có xác thực,
vì bản thân ứng dụng **chưa có cơ chế đăng nhập người dùng**.

## Cấu trúc

```
server/
  index.js              REST + WebSocket + vòng đời phiên xem
  config.js             cấu hình từ biến môi trường
  lib/
    network.js          CIDR, liệt kê interface, chặn IP public
    oui.js              tra hãng theo MAC
    portscan.js         TCP connect scan + giới hạn đồng thời
    discovery.js        arp-scan / nmap / ping sweep
    rtsp.js             bắt tay RTSP, dựng URL (Hikvision & tuỳ chỉnh)
    digest.js           HTTP Digest/Basic client
    hikvision.js        ISAPI: deviceInfo, channels, snapshot
    credentials.js      kho tài khoản AES-256-GCM
    scanner.js          điều phối quét + phát sự kiện
    mp4.js              tách fMP4 thành init + media segment
    stream.js           quản lý phiên ffmpeg
public/
  index.html  styles.css  app.js  player.js
test/
  fake-camera.js        camera giả (RTSP thật + ISAPI luôn 401) để test
  e2e.js                18 ca, đi qua đúng REST + WebSocket của trình duyệt
tools/
  check-credential.js   kiểm tra 1 bộ tài khoản qua ISAPI + RTSP, có cảnh báo khoá tài khoản
```
#   K S m a r t - S c a n _ M A C O S  
 