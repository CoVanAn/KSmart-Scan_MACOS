'use strict';
/**
 * Camera gia dung cho test - KHONG phai code chay that.
 *
 * Gom 2 phan:
 *  1. RTSP server (pull) tren cong 8554, duong dan /live
 *     ffmpeg sinh RTP + SDP; file nay lo phan signaling RTSP va relay RTP
 *     qua TCP interleaved, giong cach camera that phuc vu client.
 *  2. HTTP server tren cong 8081 gia lap ISAPI LUON tra 401 voi realm kieu
 *     Hikvision - de kiem tra truong hop "ISAPI tu choi nhung RTSP van chay".
 *
 * Chay rieng:  node test/fake-camera.js
 */
const net = require('net');
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RTSP_PORT = Number(process.env.FAKE_RTSP_PORT || 8554);
const RTP_PORT = Number(process.env.FAKE_RTP_PORT || 5004);
const ISAPI_PORT = Number(process.env.FAKE_ISAPI_PORT || 8081);
const SDP_FILE = path.join(os.tmpdir(), `fake-camera-${RTP_PORT}.sdp`);

let sdpBody = null;
const clients = new Set();

// ---------------------------------------------------------- RTP -> interleaved
//
// ffmpeg sinh MOT luong RTP lien tuc, nhung cac client (ffprobe roi ffmpeg roi
// ffmpeg transcode) noi vao o nhung thoi diem khac nhau. Neu relay nguyen xi thi
// client vao giua chung thay sequence/timestamp bat dau tu mot moc bat ky ->
// ffmpeg bao "Packet duration out of range" va luong hong ngau nhien.
// Vi vay moi client duoc cap lai seq va timestamp tu 0.
const udp = dgram.createSocket('udp4');
udp.on('message', (pkt) => {
  if (pkt.length < 12) return; // khong phai goi RTP hop le
  const origTs = pkt.readUInt32BE(4);

  for (const c of clients) {
    if (!c.playing || c.socket.destroyed) continue;
    if (c.baseTs === null) c.baseTs = origTs;

    // Phai copy: cac client dung chung buffer nay, khong duoc sua tai cho
    const rtp = Buffer.from(pkt);
    rtp.writeUInt16BE(c.seq & 0xffff, 2);
    rtp.writeUInt32BE((origTs - c.baseTs) >>> 0, 4);
    c.seq += 1;

    const header = Buffer.alloc(4);
    header[0] = 0x24; // '$'
    header[1] = c.channel;
    header.writeUInt16BE(rtp.length, 2);
    c.socket.write(Buffer.concat([header, rtp]));
  }
});

function startFfmpeg() {
  try {
    fs.unlinkSync(SDP_FILE);
  } catch {
    /* chua co */
  }
  const p = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-re',
     '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25',
     '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
     '-tune', 'zerolatency', '-g', '25',
     // global_header -> ffmpeg dua SPS/PPS vao SDP (sprop-parameter-sets)
     '-flags', '+global_header', '-an',
     '-f', 'rtp', '-sdp_file', SDP_FILE, `rtp://127.0.0.1:${RTP_PORT}`],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  p.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.error('[ffmpeg]', s.split('\n')[0]);
  });
  return p;
}

/** SDP cua ffmpeg -> SDP dung cho RTSP (port 0 + a=control). */
function toRtspSdp(raw) {
  return (
    raw
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .map((l) => l.replace(/^m=video \d+/, 'm=video 0'))
      .concat(['a=control:trackID=0'])
      .join('\r\n') + '\r\n'
  );
}

function reply(socket, status, cseq, headers = {}, body = '') {
  const lines = [`RTSP/1.0 ${status}`, `CSeq: ${cseq}`, 'Server: fake-camera/1.0'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  socket.write(lines.join('\r\n') + '\r\n\r\n' + body);
}

const rtspServer = net.createServer((socket) => {
  const client = { socket, channel: 0, playing: false, session: '12345678', seq: 0, baseTs: null };
  clients.add(client);
  let buf = '';

  socket.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    let idx;
    while ((idx = buf.indexOf('\r\n\r\n')) !== -1) {
      const head = buf.slice(0, idx);
      buf = buf.slice(idx + 4);
      const [method] = head.split('\r\n')[0].split(' ');
      const cseq = (/^CSeq:\s*(\d+)/im.exec(head) || [, '0'])[1];

      if (method === 'OPTIONS') {
        reply(socket, '200 OK', cseq, { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN' });
      } else if (method === 'DESCRIBE') {
        if (!sdpBody) reply(socket, '503 Service Unavailable', cseq);
        else
          reply(socket, '200 OK', cseq,
            { 'Content-Type': 'application/sdp', 'Content-Base': `rtsp://127.0.0.1:${RTSP_PORT}/live/` },
            sdpBody);
      } else if (method === 'SETUP') {
        const il = /interleaved=(\d+)-(\d+)/.exec(head);
        client.channel = il ? Number(il[1]) : 0;
        reply(socket, '200 OK', cseq, {
          Transport: `RTP/AVP/TCP;unicast;interleaved=${client.channel}-${client.channel + 1}`,
          Session: `${client.session};timeout=60`,
        });
      } else if (method === 'PLAY') {
        client.playing = true;
        client.baseTs = null;
        client.seq = 0;
        reply(socket, '200 OK', cseq, { Session: client.session, 'RTP-Info': 'url=trackID=0' });
      } else if (method === 'TEARDOWN') {
        client.playing = false;
        reply(socket, '200 OK', cseq, { Session: client.session });
        socket.end();
      } else if (method === 'GET_PARAMETER') {
        reply(socket, '200 OK', cseq, { Session: client.session });
      } else {
        reply(socket, '405 Method Not Allowed', cseq);
      }
    }
  });

  socket.on('error', () => {});
  socket.on('close', () => clients.delete(client));
});

// ------------------------------------------- ISAPI gia: luon tu choi bang 401
const isapiServer = http.createServer((req, res) => {
  res.writeHead(401, {
    'WWW-Authenticate': 'Digest qop="auth", realm="IP Camera(FAKE01)", nonce="deadbeef", stale="FALSE"',
    'Content-Type': 'text/html',
    Server: 'webserver',
  });
  res.end('<html><body>401 Unauthorized</body></html>');
});

const ff = startFfmpeg();

const waitSdp = setInterval(() => {
  let raw;
  try {
    raw = fs.readFileSync(SDP_FILE, 'utf8');
  } catch {
    return;
  }
  if (!/m=video/.test(raw) || !/a=rtpmap/.test(raw)) return;
  clearInterval(waitSdp);
  sdpBody = toRtspSdp(raw);
  udp.bind(RTP_PORT, '127.0.0.1', () => {
    isapiServer.listen(ISAPI_PORT, '127.0.0.1', () => {
      rtspServer.listen(RTSP_PORT, '127.0.0.1', () => {
        console.log(`READY rtsp://127.0.0.1:${RTSP_PORT}/live | ISAPI-401 tai :${ISAPI_PORT}`);
      });
    });
  });
}, 200);

const shutdown = () => {
  try {
    ff.kill('SIGKILL');
  } catch {
    /* da chet */
  }
  rtspServer.close();
  isapiServer.close();
  try {
    udp.close();
  } catch {
    /* da dong */
  }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Neu tien trinh cha bi SIGKILL (khong bat duoc), stdin se dong theo.
// Thieu cai nay thi ffmpeg con lai mo coi, va lan chay test sau se co HAI nguon
// RTP cung ban vao mot cong -> luong rac, test hong ngau nhien.
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.stdin.resume();
