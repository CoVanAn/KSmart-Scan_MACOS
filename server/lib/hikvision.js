'use strict';

const digest = require('./digest');

/** Lay gia tri 1 the XML don gian (ISAPI tra ve XML phang, khong can parser nang). */
function xmlValue(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(xml || '');
  return m ? m[1].trim() : null;
}

function xmlAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml || '')) !== null) out.push(m[1].trim());
  return out;
}

/**
 * Do khong can mat khau: 401 tu ISAPI da du de ket luan la Hikvision.
 * Hikvision tra ve realm dang 'IP Camera(XXXXX)' hoac 'DS-XXXX'.
 */
async function probeAnonymous(ip, port = 80, { tls = false, timeout = 4000 } = {}) {
  const result = {
    isapi: false,
    isHikvision: false,
    realm: null,
    authScheme: null,
    server: null,
    status: null,
    evidence: [],
  };

  try {
    const res = await digest.rawRequest({
      host: ip,
      port,
      path: '/ISAPI/System/deviceInfo',
      tls,
      timeout,
    });
    result.status = res.status;
    result.server = res.headers.server || null;

    const challenge = digest.parseAuthenticate(res.headers['www-authenticate']);
    if (challenge) {
      result.authScheme = challenge.scheme;
      result.realm = challenge.params.realm || null;
    }

    if (res.status === 401 || res.status === 200) {
      result.isapi = true;
      result.evidence.push(`ISAPI trả về HTTP ${res.status}`);
    }

    const hay = `${result.realm || ''} ${result.server || ''} ${String(res.body).slice(0, 2000)}`;
    if (/hikvision|IP Camera|DS-[0-9A-Z]|App-webs|webs/i.test(hay)) {
      result.isHikvision = true;
      if (result.realm) result.evidence.push(`realm="${result.realm}"`);
      if (result.server) result.evidence.push(`Server: ${result.server}`);
    }
    if (res.status === 200 && /<DeviceInfo/i.test(String(res.body))) {
      // Camera dang o che do khong yeu cau xac thuc
      result.isHikvision = true;
      result.isapi = true;
      result.anonymousAccess = true;
      result.deviceInfo = parseDeviceInfo(res.body);
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

function parseDeviceInfo(xml) {
  return {
    deviceName: xmlValue(xml, 'deviceName'),
    deviceId: xmlValue(xml, 'deviceID'),
    model: xmlValue(xml, 'model'),
    serialNumber: xmlValue(xml, 'serialNumber'),
    macAddress: xmlValue(xml, 'macAddress'),
    firmwareVersion: xmlValue(xml, 'firmwareVersion'),
    firmwareReleasedDate: xmlValue(xml, 'firmwareReleasedDate'),
    deviceType: xmlValue(xml, 'deviceType'),
    encoderVersion: xmlValue(xml, 'encoderVersion'),
  };
}

/** Lay thong tin thiet bi (can user/pass). */
async function getDeviceInfo(ip, port, username, password, { tls = false, timeout = 6000 } = {}) {
  const res = await digest.request({
    host: ip,
    port,
    path: '/ISAPI/System/deviceInfo',
    tls,
    timeout,
    username,
    password,
  });
  if (res.status === 401) {
    const err = new Error('Sai tài khoản hoặc mật khẩu (HTTP 401)');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
  if (res.status === 403) {
    const err = new Error('Bị từ chối (403) — tài khoản có thể đang bị khoá do đăng nhập sai nhiều lần');
    err.code = 'FORBIDDEN';
    throw err;
  }
  if (res.status !== 200) {
    const err = new Error(`ISAPI trả về HTTP ${res.status}`);
    err.code = 'BAD_STATUS';
    throw err;
  }
  return { ...parseDeviceInfo(res.body), authScheme: res.authScheme };
}

/**
 * Danh sach kenh video. Camera don thuong tra ve 1 kenh, NVR tra ve N kenh.
 * Thu ca /ISAPI/ContentMgmt/InputProxy (NVR) va /ISAPI/System/Video/inputs (camera).
 */
async function getChannels(ip, port, username, password, { tls = false, timeout = 6000 } = {}) {
  const call = (path) =>
    digest.request({ host: ip, port, path, tls, timeout, username, password }).catch(() => null);

  const channels = [];

  const streaming = await call('/ISAPI/Streaming/channels');
  if (streaming && streaming.status === 200) {
    const blocks = String(streaming.body).split(/<StreamingChannel[\s>]/i).slice(1);
    for (const b of blocks) {
      const id = xmlValue(b, 'id');
      if (!id) continue;
      const idNum = Number(id);
      // id = <channel><stream>, vd 101 = kenh 1 stream chinh, 102 = sub
      const channel = Math.floor(idNum / 10);
      const stream = idNum % 10;
      channels.push({
        id: idNum,
        channel,
        stream: stream === 1 ? 'main' : stream === 2 ? 'sub' : 'third',
        name: xmlValue(b, 'channelName') || `Kênh ${channel}`,
        codec: xmlValue(b, 'videoCodecType'),
        resolution:
          xmlValue(b, 'videoResolutionWidth') && xmlValue(b, 'videoResolutionHeight')
            ? `${xmlValue(b, 'videoResolutionWidth')}x${xmlValue(b, 'videoResolutionHeight')}`
            : null,
        frameRate: xmlValue(b, 'maxFrameRate') ? Number(xmlValue(b, 'maxFrameRate')) / 100 : null,
        enabled: xmlValue(b, 'enabled') !== 'false',
      });
    }
  }

  if (!channels.length) {
    const inputs = await call('/ISAPI/System/Video/inputs/channels');
    if (inputs && inputs.status === 200) {
      const ids = xmlAll(inputs.body, 'id');
      for (const id of ids) {
        const channel = Number(id);
        if (!channel) continue;
        channels.push({ id: channel * 100 + 1, channel, stream: 'main', name: `Kênh ${channel}` });
        channels.push({ id: channel * 100 + 2, channel, stream: 'sub', name: `Kênh ${channel}` });
      }
    }
  }

  if (!channels.length) {
    channels.push(
      { id: 101, channel: 1, stream: 'main', name: 'Kênh 1' },
      { id: 102, channel: 1, stream: 'sub', name: 'Kênh 1' }
    );
  }

  return channels.sort((a, b) => a.id - b.id);
}

/** Anh chup nhanh JPEG - dung lam thumbnail, nhe hon nhieu so voi mo video. */
async function getSnapshot(ip, port, username, password, { channel = 101, tls = false, timeout = 8000 } = {}) {
  const res = await digest.request({
    host: ip,
    port,
    path: `/ISAPI/Streaming/channels/${channel}/picture`,
    tls,
    timeout,
    username,
    password,
    binary: true,
  });
  if (res.status !== 200) {
    const err = new Error(`Không lấy được snapshot (HTTP ${res.status})`);
    err.code = res.status === 401 ? 'UNAUTHORIZED' : 'BAD_STATUS';
    throw err;
  }
  const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body, 'binary');
  return { buffer: body, contentType: res.headers['content-type'] || 'image/jpeg' };
}

module.exports = {
  probeAnonymous,
  getDeviceInfo,
  getChannels,
  getSnapshot,
  parseDeviceInfo,
  xmlValue,
  xmlAll,
};
