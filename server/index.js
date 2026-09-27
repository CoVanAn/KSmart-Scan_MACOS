'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const net = require('./lib/network');
const hik = require('./lib/hikvision');
const { ScanManager } = require('./lib/scanner');
const { CredentialStore } = require('./lib/credentials');
const { StreamManager } = require('./lib/stream');
const { buildRtspUrl, maskUrl } = require('./lib/rtsp');
const { probeStream } = require('./lib/stream');

const app = express();
const server = http.createServer(app);

const scanner = new ScanManager();
const creds = new CredentialStore(config.dataDir).init();
const streams = new StreamManager();

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));

const IP_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function requirePrivateIp(req, res, next) {
  const { ip } = req.params;
  if (!IP_RE.test(ip)) return res.status(400).json({ error: 'IP không hợp lệ' });
  if (!net.isPrivate(ip)) {
    return res.status(403).json({ error: 'Chỉ hỗ trợ IP trong mạng nội bộ (private)' });
  }
  next();
}

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err.code === 'UNAUTHORIZED' ? 401 : err.code === 'SCAN_BUSY' ? 409 : 500;
    res.status(status).json({ error: err.message, code: err.code || null });
  });
};

// ---------------------------------------------------------------- API: mang

app.get('/api/interfaces', (req, res) => {
  const ifaces = net.listInterfaces();
  res.json({
    interfaces: ifaces,
    suggested: ifaces.find((i) => net.isPrivate(i.address)) || ifaces[0] || null,
    defaultPorts: config.scan.ports,
  });
});

// ---------------------------------------------------------------- API: quet

app.post(
  '/api/scan',
  wrap(async (req, res) => {
    const { cidr, ports, iface, useArpScan } = req.body || {};
    let target = cidr;
    if (!target) {
      const suggested = net.listInterfaces().find((i) => net.isPrivate(i.address));
      if (!suggested) return res.status(400).json({ error: 'Không tìm thấy card mạng phù hợp' });
      target = suggested.scanCidr;
    }
    const scan = scanner.start({
      cidr: target,
      ports: Array.isArray(ports) ? ports.map(Number) : undefined,
      iface,
      useArpScan,
    });
    res.json({ scan: publicScan(scan) });
  })
);

app.post('/api/scan/:id/cancel', (req, res) => {
  res.json({ cancelled: scanner.cancel(req.params.id) });
});

app.get('/api/scan/:id', (req, res) => {
  const scan = scanner.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Không tìm thấy phiên quét' });
  res.json({ scan: publicScan(scan), devices: scan.found.map((ip) => scanner.getDevice(ip)).filter(Boolean) });
});

function publicScan(scan) {
  const { cancelled, found, ...rest } = scan;
  return { ...rest, foundCount: found.length };
}

// ------------------------------------------------------------- API: thiet bi

app.get('/api/devices', (req, res) => {
  const savedIps = new Set(creds.listSafe().map((c) => c.ip));
  const devices = scanner.listDevices().map((d) => ({ ...d, hasCredentials: savedIps.has(d.ip) }));
  res.json({ devices, credentials: creds.listSafe(), streams: streams.list() });
});

app.get('/api/devices/:ip', requirePrivateIp, (req, res) => {
  const device = scanner.getDevice(req.params.ip);
  if (!device) return res.status(404).json({ error: 'Thiết bị chưa được quét' });
  res.json({ device: { ...device, hasCredentials: creds.has(req.params.ip) } });
});

/** Buoc 2: nhan user/pass tu popup, xac thuc thuc su, roi moi luu. */
app.post(
  '/api/devices/:ip/credentials',
  requirePrivateIp,
  wrap(async (req, res) => {
    const { ip } = req.params;
    const { username, password, httpPort, rtspPort, tls, rtspPath, save = true } = req.body || {};
    if (!username) return res.status(400).json({ error: 'Thiếu username' });

    const device = scanner.getDevice(ip) || {};
    const hPort = Number(httpPort) || device.httpPort || 80;
    const rPort = Number(rtspPort) || device.rtspPort || 554;
    const useTls = tls !== undefined ? !!tls : hPort === 443;
    const customPath = rtspPath && String(rtspPath).trim() ? String(rtspPath).trim() : null;

    const result = { ip, httpPort: hPort, rtspPort: rPort, tls: useTls, rtspPath: customPath };

    // (a) Xac thuc qua ISAPI - cho biet model / serial / firmware
    try {
      result.deviceInfo = await hik.getDeviceInfo(ip, hPort, username, password, { tls: useTls });
      result.isapiOk = true;
    } catch (err) {
      result.isapiOk = false;
      result.isapiError = err.message;
      result.isapiCode = err.code || null;
      // KHONG thoat som o day. Nhieu camera OEM/rebrand co ISAPI tra 401 hoac
      // khong day du, nhung RTSP van nhan dung tai khoan - va RTSP moi la dieu
      // kien thuc su de xem duoc video.
    }

    // (b) Xac thuc qua RTSP - day moi la dieu kien de xem duoc video.
    // Thu lan luot: path tự đặt (neu co) -> chuẩn Hikvision -> Hikvision đời cũ.
    const variants = customPath
      ? [{ path: customPath, label: 'path tự đặt' }]
      : [{ label: 'chuẩn Hikvision' }, { legacy: true, label: 'Hikvision đời cũ' }];

    result.rtspOk = false;
    for (const v of variants) {
      const url = buildRtspUrl({
        ip,
        port: rPort,
        username,
        password,
        channel: 1,
        stream: 'main',
        path: v.path,
        legacy: v.legacy,
      });
      try {
        result.stream = await probeStream(url);
        result.rtspOk = true;
        result.legacyPath = !!v.legacy;
        result.rtspVariant = v.label;
        result.rtspUrlTemplate = maskUrl(url);
        break;
      } catch (err) {
        if (!result.rtspError) result.rtspError = err.message;
      }
    }

    if (!result.isapiOk && !result.rtspOk) {
      return res.status(401).json({
        error: `Không xác thực được. ISAPI: ${result.isapiError || 'lỗi'}. RTSP: ${result.rtspError || 'lỗi'}`,
        code: 'AUTH_FAILED',
        result,
      });
    }

    // (c) Lay danh sach kenh (NVR se co nhieu kenh)
    if (result.isapiOk) {
      try {
        result.channels = await hik.getChannels(ip, hPort, username, password, { tls: useTls });
      } catch {
        result.channels = null;
      }
    }

    if (save) {
      creds.set(ip, {
        username,
        password,
        httpPort: hPort,
        rtspPort: rPort,
        tls: useTls,
        rtspPath: customPath,
        legacy: !!result.legacyPath,
      });
    }

    scanner.annotate(ip, {
      hasCredentials: save,
      deviceInfo: result.deviceInfo || (scanner.getDevice(ip) || {}).deviceInfo || null,
      channels: result.channels || null,
      needsCredentials: false,
      httpPort: hPort,
      rtspPort: rPort,
      streamInfo: result.stream || null,
      legacyPath: !!result.legacyPath,
    });

    res.json({ ok: true, result });
  })
);

app.delete('/api/devices/:ip/credentials', requirePrivateIp, (req, res) => {
  const removed = creds.remove(req.params.ip);
  scanner.annotate(req.params.ip, { hasCredentials: false, needsCredentials: true });
  res.json({ removed });
});

app.get(
  '/api/devices/:ip/channels',
  requirePrivateIp,
  wrap(async (req, res) => {
    const cred = creds.get(req.params.ip);
    if (!cred) return res.status(401).json({ error: 'Chưa lưu tài khoản cho thiết bị này' });
    const channels = await hik.getChannels(
      req.params.ip,
      cred.httpPort,
      cred.username,
      cred.password,
      { tls: cred.tls }
    );
    res.json({ channels });
  })
);

/** Proxy snapshot JPEG - dung lam thumbnail, re hon nhieu so voi mo video. */
app.get(
  '/api/devices/:ip/snapshot',
  requirePrivateIp,
  wrap(async (req, res) => {
    const cred = creds.get(req.params.ip);
    if (!cred) return res.status(401).json({ error: 'Chưa lưu tài khoản cho thiết bị này' });
    const channel = Number(req.query.channel) || 101;
    try {
      const shot = await hik.getSnapshot(req.params.ip, cred.httpPort, cred.username, cred.password, {
        channel,
        tls: cred.tls,
      });
      res.set('Content-Type', shot.contentType);
      res.set('Cache-Control', 'no-store');
      res.send(shot.buffer);
    } catch (err) {
      res.status(err.code === 'UNAUTHORIZED' ? 401 : 502).json({ error: err.message });
    }
  })
);

app.get('/api/streams', (req, res) => res.json({ streams: streams.list() }));

// ------------------------------------------------------- WebSocket: su kien

const eventsWss = new WebSocketServer({ noServer: true });
const streamWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

eventsWss.on('connection', (ws) => {
  const savedIps = new Set(creds.listSafe().map((c) => c.ip));
  ws.send(
    JSON.stringify({
      type: 'snapshot',
      devices: scanner.listDevices().map((d) => ({ ...d, hasCredentials: savedIps.has(d.ip) })),
      scan: scanner.active ? publicScan(scanner.active) : null,
      streams: streams.list(),
    })
  );
});

scanner.on('event', (evt) => {
  const payload = JSON.stringify(
    evt.type === 'device' ? { ...evt, device: { ...evt.device, hasCredentials: creds.has(evt.device.ip) } } : evt
  );
  for (const ws of eventsWss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
});

// --------------------------------------------------- WebSocket: luong video

/** Mot nguoi xem dang gan vao StreamSession. */
class StreamClient {
  constructor(ws) {
    this.ws = ws;
    this.dropped = 0;
  }

  _send(data) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    // Chong tran bo dem khi mang cua client cham hon luong video
    if (this.ws.bufferedAmount > 4 * 1024 * 1024) {
      this.dropped += 1;
      if (this.dropped > 50) this.ws.close(1011, 'client quá chậm');
      return;
    }
    this.ws.send(data);
  }

  sendMeta(meta) {
    this._send(JSON.stringify({ type: 'meta', ...meta }));
  }

  sendInit(buf) {
    if (this.initSent) return;
    this.initSent = true;
    this._send(buf);
  }

  sendSegment(buf) {
    if (!this.initSent) return;
    this._send(buf);
  }

  fail(reason) {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ type: 'error', error: reason }));
      this.ws.close(1011, 'stream lỗi');
    }
  }
}

streamWss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = url.searchParams.get('ip');
  const channel = Number(url.searchParams.get('channel')) || 1;
  const streamType = url.searchParams.get('stream') === 'sub' ? 'sub' : 'main';
  const forceTranscode = url.searchParams.get('transcode') === '1';

  const fail = (msg) => {
    try {
      ws.send(JSON.stringify({ type: 'error', error: msg }));
    } catch {
      /* ignore */
    }
    ws.close(1008, 'từ chối');
  };

  if (!ip || !IP_RE.test(ip) || !net.isPrivate(ip)) return fail('IP không hợp lệ');

  const cred = creds.get(ip);
  if (!cred) return fail('Chưa có tài khoản cho camera này. Hãy nhập tài khoản trước.');

  const rtspUrl = buildRtspUrl({
    ip,
    port: cred.rtspPort,
    username: cred.username,
    password: cred.password,
    channel,
    stream: streamType,
    path: cred.rtspPath,
    legacy: cred.legacy,
  });

  // Luong "copy" va luong "transcode" la hai phien khac nhau -> key phai khac
  const key = `${ip}:${cred.rtspPort}/${channel}/${streamType}${forceTranscode ? '/tc' : ''}`;
  const client = new StreamClient(ws);

  let session;
  try {
    session = await streams.acquire(key, rtspUrl, { forceTranscode });
  } catch (err) {
    return fail(err.message);
  }

  if (ws.readyState !== ws.OPEN) {
    session.removeClient(client);
    return;
  }

  session.addClient(client);

  ws.on('close', () => session.removeClient(client));
  ws.on('error', () => session.removeClient(client));
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws/events') {
    eventsWss.handleUpgrade(req, socket, head, (ws) => eventsWss.emit('connection', ws, req));
  } else if (pathname === '/ws/stream') {
    streamWss.handleUpgrade(req, socket, head, (ws) => streamWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ------------------------------------------------------------------- khoi dong

server.listen(config.port, config.host, () => {
  const ifaces = net.listInterfaces();
  console.log(`\n  find-ip-device dang chay: http://${config.host}:${config.port}`);
  console.log(`  Interface phat hien duoc:`);
  for (const i of ifaces) console.log(`    - ${i.name}  ${i.address}  (quet: ${i.scanCidr})`);
  if (config.host === '127.0.0.1') {
    console.log(`  (Chi truy cap tu may nay. Dat HOST=0.0.0.0 neu can mo cho may khac.)\n`);
  } else {
    console.log('');
  }
});

const shutdown = () => {
  console.log('\nDang dong...');
  streams.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
