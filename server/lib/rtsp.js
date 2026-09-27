'use strict';

const net = require('net');

/**
 * Bat tay RTSP tho: gui OPTIONS roi DESCRIBE de xac nhan day la RTSP server
 * va lay header Server/WWW-Authenticate (thuong tiet lo hang san xuat).
 */
function probeRtsp(host, port = 554, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buf = '';
    let stage = 0;
    const result = { rtsp: false, server: null, realm: null, requiresAuth: false, public: null };
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    const send = (text) => {
      try {
        socket.write(text);
      } catch {
        finish();
      }
    };

    socket.setTimeout(timeout);
    socket.once('timeout', finish);
    socket.once('error', finish);

    socket.connect(port, host, () => {
      stage = 1;
      send(
        `OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: find-ip-device\r\n\r\n`
      );
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (!/\r\n\r\n/.test(buf)) return;

      if (/^RTSP\/1\.\d\s+\d+/.test(buf)) result.rtsp = true;
      const server = /^Server:\s*(.+)$/im.exec(buf);
      if (server && !result.server) result.server = server[1].trim();
      const pub = /^Public:\s*(.+)$/im.exec(buf);
      if (pub && !result.public) result.public = pub[1].trim();

      if (stage === 1) {
        stage = 2;
        buf = '';
        send(
          `DESCRIBE rtsp://${host}:${port}/Streaming/Channels/101 RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\nUser-Agent: find-ip-device\r\n\r\n`
        );
        return;
      }

      const status = /^RTSP\/1\.\d\s+(\d+)/.exec(buf);
      if (status && Number(status[1]) === 401) result.requiresAuth = true;
      const realm = /realm\s*=\s*"([^"]*)"/i.exec(buf);
      if (realm) result.realm = realm[1];
      finish();
    });
  });
}

function authPart(username, password) {
  if (username === undefined || username === null || username === '') return '';
  return `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@`;
}

/** URL RTSP chuan cua Hikvision: /Streaming/Channels/<kenh><stream>. */
function hikRtspUrl({ ip, port = 554, username, password, channel = 1, stream = 'main' }) {
  const ch = Number(channel) || 1;
  const streamId = stream === 'sub' ? 2 : stream === 'third' ? 3 : 1;
  return `rtsp://${authPart(username, password)}${ip}:${port}/Streaming/Channels/${ch}${streamId}`;
}

/** URL RTSP kieu cu (firmware Hikvision doi truoc 5.x). */
function hikLegacyRtspUrl({ ip, port = 554, username, password, channel = 1, stream = 'main' }) {
  return `rtsp://${authPart(username, password)}${ip}:${port}/h264/ch${Number(channel) || 1}/${
    stream === 'sub' ? 'sub' : 'main'
  }/av_stream`;
}

/**
 * Duong dan RTSP tu dat - danh cho camera khong theo chuan Hikvision
 * (ONVIF, Dahua, Uniview...). Ho tro placeholder %CH% va %ST%.
 *   vd: /cam/realmonitor?channel=%CH%&subtype=%ST%
 */
function customRtspUrl({ ip, port = 554, username, password, channel = 1, stream = 'main', path = '/' }) {
  const p = String(path).startsWith('/') ? path : `/${path}`;
  const resolved = p
    .replace(/%CH%/g, String(Number(channel) || 1))
    .replace(/%ST%/g, stream === 'sub' ? '1' : '0');
  return `rtsp://${authPart(username, password)}${ip}:${port}${resolved}`;
}

/** Chon cach dung URL theo cau hinh da luu cua thiet bi. */
function buildRtspUrl(opts) {
  if (opts.path) return customRtspUrl(opts);
  if (opts.legacy) return hikLegacyRtspUrl(opts);
  return hikRtspUrl(opts);
}

/** Che mat khau khi ghi log / tra ve frontend. */
function maskUrl(url) {
  return String(url).replace(/\/\/([^:/@]+):([^@]*)@/, '//$1:***@');
}

module.exports = { probeRtsp, hikRtspUrl, hikLegacyRtspUrl, customRtspUrl, buildRtspUrl, maskUrl };
