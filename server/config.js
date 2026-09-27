'use strict';

const path = require('path');

const num = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const list = (v, d) =>
  (v === undefined || v === '' ? d : v)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);

module.exports = {
  // Mac dinh chi bind localhost. Doi sang 0.0.0.0 neu muon truy cap tu may khac.
  host: process.env.HOST || '127.0.0.1',
  port: num(process.env.PORT, 3000),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  scan: {
    // Cong mac dinh duoc do tren moi host
    ports: list(process.env.SCAN_PORTS, '554,8000,80,443,8080,8554,2020,37777'),
    // Mo cac cong nay => nghi ngo la camera
    cameraPorts: [554, 8000, 8554, 37777],
    // Cac cong co the chua web UI cua camera
    httpPorts: [80, 8080, 443],
    portTimeout: num(process.env.PORT_TIMEOUT, 900),
    portConcurrency: num(process.env.PORT_CONCURRENCY, 300),
    hostConcurrency: num(process.env.HOST_CONCURRENCY, 64),
    pingConcurrency: num(process.env.PING_CONCURRENCY, 128),
    maxHosts: num(process.env.MAX_HOSTS, 4096),
    useNmap: process.env.USE_NMAP !== '0',
    // arp-scan can sudo NOPASSWD nen khong dua ra UI (tick vao gan nhu luon
    // im lang lui ve nmap). Chi bat qua env, hoac qua body cua POST /api/scan.
    useArpScan: process.env.USE_ARP_SCAN === '1',
  },

  stream: {
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
    // Giu ffmpeg song them bao lau sau khi client cuoi cung roi di (ms)
    idleTimeout: num(process.env.STREAM_IDLE_TIMEOUT, 8000),
    // Do dai fragment (microsecond) - nho hon = tre thap hon
    fragDuration: num(process.env.FRAG_DURATION, 400000),
    // Dung khi phai transcode H.265 -> H.264
    transcodeBitrate: process.env.TRANSCODE_BITRATE || '2000k',
    transcodePreset: process.env.TRANSCODE_PRESET || 'ultrafast',
    maxSessions: num(process.env.MAX_STREAM_SESSIONS, 8),
    probeTimeout: num(process.env.PROBE_TIMEOUT, 12000),
  },
};
