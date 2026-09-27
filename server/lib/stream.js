'use strict';

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const config = require('../config');
const { Mp4Segmenter } = require('./mp4');
const { maskUrl } = require('./rtsp');

/** Codec video ma MSE phat truc tiep duoc; con lai phai transcode. */
const MSE_SAFE_CODECS = new Set(['h264']);

/** Doc thong tin luong RTSP truoc khi mo phien (de biet co phai transcode khong). */
function probeStream(rtspUrl, { timeout = config.stream.probeTimeout } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-analyzeduration', '2000000',
      '-probesize', '1000000',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,profile,level',
      '-of', 'json',
      '-i', rtspUrl,
    ];
    const child = execFile(
      config.stream.ffprobe,
      args,
      { timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim().split('\n').pop() || 'ffprobe thất bại';
          const e = new Error(`Không đọc được luồng RTSP: ${msg}`);
          e.code = /401|Unauthorized/i.test(stderr || '') ? 'UNAUTHORIZED' : 'PROBE_FAILED';
          return reject(e);
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return reject(new Error('ffprobe trả về dữ liệu không đọc được'));
        }
        const s = (parsed.streams || [])[0];
        if (!s) return reject(new Error('Không tìm thấy luồng video trong RTSP'));
        const [num, den] = String(s.avg_frame_rate || '0/1').split('/').map(Number);
        resolve({
          codec: s.codec_name || null,
          width: s.width || null,
          height: s.height || null,
          fps: den ? Math.round((num / den) * 100) / 100 : null,
          profile: s.profile || null,
          level: s.level || null,
        });
      }
    );
    child.on('error', reject);
  });
}

/**
 * Mot phien ffmpeg: RTSP -> fragmented MP4 -> phat cho nhieu client qua WebSocket.
 * Nhieu nguoi xem cung 1 camera dung chung 1 process ffmpeg.
 */
class StreamSession extends EventEmitter {
  constructor(key, rtspUrl, meta) {
    super();
    this.key = key;
    this.rtspUrl = rtspUrl;
    this.meta = meta; // { codec, width, height, fps, transcode }
    this.clients = new Set();
    this.initSegment = null;
    this.proc = null;
    this.idleTimer = null;
    this.stderrTail = [];
    this.stats = { bytes: 0, segments: 0, startedAt: Date.now() };
    this.stopped = false;
  }

  get ffmpegArgs() {
    const input = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-analyzeduration', '1000000',
      '-probesize', '500000',
      '-i', this.rtspUrl,
    ];

    const video = this.meta.transcode
      ? [
          '-c:v', 'libx264',
          '-preset', config.stream.transcodePreset,
          '-tune', 'zerolatency',
          '-profile:v', 'main',
          '-pix_fmt', 'yuv420p',
          '-b:v', config.stream.transcodeBitrate,
          '-maxrate', config.stream.transcodeBitrate,
          '-bufsize', '1M',
          '-g', '30',
        ]
      : ['-c:v', 'copy'];

    return [
      ...input,
      '-an', // bo audio: tranh phu thuoc codec G.711/AAC phia browser
      ...video,
      '-f', 'mp4',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
      '-frag_duration', String(config.stream.fragDuration),
      'pipe:1',
    ];
  }

  start() {
    if (this.proc) return;
    const args = this.ffmpegArgs;
    console.log(`[stream] ${this.key} -> ffmpeg (${this.meta.transcode ? 'transcode H.264' : 'copy'})`);

    this.proc = spawn(config.stream.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const segmenter = new Mp4Segmenter({
      onInit: (buf) => {
        this.initSegment = buf;
        this.emit('init', buf);
        for (const c of this.clients) c.sendInit(buf);
      },
      onSegment: (buf) => {
        this.stats.bytes += buf.length;
        this.stats.segments += 1;
        for (const c of this.clients) c.sendSegment(buf);
      },
    });

    this.proc.stdout.on('data', (chunk) => {
      try {
        segmenter.write(chunk);
      } catch (err) {
        console.error(`[stream] ${this.key} loi tach mp4: ${err.message}`);
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      this.stderrTail.push(text);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      if (/401|Unauthorized|Invalid data|Connection refused|timed out/i.test(text)) {
        console.warn(`[stream] ${this.key}: ${text}`);
      }
    });

    this.proc.once('error', (err) => this._die(`Không chạy được ffmpeg: ${err.message}`));
    this.proc.once('exit', (code, signal) => {
      if (this.stopped) return;
      const tail = this.stderrTail.slice(-3).join(' | ');
      this._die(`ffmpeg kết thúc (code=${code}, signal=${signal || '-'}) ${tail}`);
    });
  }

  _die(reason) {
    console.warn(`[stream] ${this.key} dung: ${reason}`);
    for (const c of this.clients) c.fail(reason);
    this.clients.clear();
    this.stop();
    this.emit('closed', reason);
  }

  addClient(client) {
    this.clients.add(client);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    client.sendMeta({ ...this.meta, key: this.key });
    if (this.initSegment) client.sendInit(this.initSegment);
    this.start();
  }

  removeClient(client) {
    this.clients.delete(client);
    if (this.clients.size === 0 && !this.idleTimer && !this.stopped) {
      this.idleTimer = setTimeout(() => {
        if (this.clients.size === 0) {
          this.stop();
          this.emit('closed', 'không còn người xem');
        }
      }, config.stream.idleTimeout);
    }
  }

  stop() {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      try {
        proc.stdout.removeAllListeners();
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* da chet */
          }
        }, 2000).unref();
      } catch {
        /* da chet */
      }
    }
  }

  info() {
    const uptime = (Date.now() - this.stats.startedAt) / 1000;
    return {
      key: this.key,
      url: maskUrl(this.rtspUrl),
      viewers: this.clients.size,
      codec: this.meta.codec,
      transcode: this.meta.transcode,
      resolution: this.meta.width ? `${this.meta.width}x${this.meta.height}` : null,
      fps: this.meta.fps,
      segments: this.stats.segments,
      kbps: uptime > 0 ? Math.round((this.stats.bytes * 8) / uptime / 1000) : 0,
      uptimeSec: Math.round(uptime),
    };
  }
}

class StreamManager {
  constructor() {
    this.sessions = new Map();
  }

  list() {
    return [...this.sessions.values()].map((s) => s.info());
  }

  /**
   * Lay hoac tao phien cho 1 URL RTSP. `key` phai khong chua mat khau.
   * forceTranscode: buoc re-encode ngay ca khi da la H.264 - dung khi trinh duyet
   * khong giai ma duoc luong goc (profile la, 4:4:4, bitstream loi).
   */
  async acquire(key, rtspUrl, { forceTranscode = false } = {}) {
    const existing = this.sessions.get(key);
    if (existing && !existing.stopped) return existing;

    if (this.sessions.size >= config.stream.maxSessions) {
      const err = new Error(
        `Đã đạt giới hạn ${config.stream.maxSessions} luồng đồng thời. Hãy đóng bớt cửa sổ xem.`
      );
      err.code = 'TOO_MANY_SESSIONS';
      throw err;
    }

    const probe = await probeStream(rtspUrl);
    const transcode = forceTranscode || !MSE_SAFE_CODECS.has(String(probe.codec).toLowerCase());

    const session = new StreamSession(key, rtspUrl, { ...probe, transcode, forced: forceTranscode });
    this.sessions.set(key, session);
    session.once('closed', () => {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    });
    return session;
  }

  stopAll() {
    for (const s of this.sessions.values()) s.stop();
    this.sessions.clear();
  }
}

module.exports = { StreamManager, StreamSession, probeStream, MSE_SAFE_CODECS };
