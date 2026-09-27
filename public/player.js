'use strict';

/**
 * Player fragmented-MP4 qua WebSocket, dung Media Source Extensions.
 * Giao thuc tu server:
 *   1. text  : {"type":"meta", codec, width, height, fps, transcode}
 *   2. binary: init segment (ftyp+moov)  <- luon la goi binary dau tien
 *   3. binary: cac media segment (moof+mdat) lien tuc
 *   text {"type":"error"} co the den bat cu luc nao.
 */

const hex2 = (n) => n.toString(16).padStart(2, '0');

/** Doc codec string tu box avcC/hvcC trong init segment (MSE yeu cau chinh xac). */
function codecFromInit(buffer) {
  const u8 = new Uint8Array(buffer);
  for (let i = 0; i + 8 < u8.length; i += 1) {
    // 'avcC'
    if (u8[i] === 0x61 && u8[i + 1] === 0x76 && u8[i + 2] === 0x63 && u8[i + 3] === 0x43) {
      return `avc1.${hex2(u8[i + 5])}${hex2(u8[i + 6])}${hex2(u8[i + 7])}`;
    }
    // 'hvcC'
    if (u8[i] === 0x68 && u8[i + 1] === 0x76 && u8[i + 2] === 0x63 && u8[i + 3] === 0x43) {
      return 'hvc1.1.6.L93.B0';
    }
  }
  return 'avc1.640028';
}

class Fmp4Player {
  constructor(video, { onStatus, onStats, maxLatency = 1.5, bufferWindow = 20 } = {}) {
    this.video = video;
    this.onStatus = onStatus || (() => {});
    this.onStats = onStats || (() => {});
    this.maxLatency = maxLatency;
    this.bufferWindow = bufferWindow;

    this.ws = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.meta = null;
    this.bytes = 0;
    this.segments = 0;
    this.startedAt = 0;
    this.destroyed = false;
    this.statsTimer = null;
    this.fatal = false;

    // Loi giai ma phai doc tu video.error. Neu khong bat o day, moi appendBuffer
    // sau do se nem ra "HTMLMediaElement.error attribute is not null" - che mat
    // nguyen nhan that (vd: PIPELINE_ERROR_DECODE).
    this._onVideoError = () => {
      const err = this.video.error;
      if (!err || this.fatal) return;
      this.fatal = true;
      this.queue = [];
      const names = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
      this.onStatus({
        state: 'fatal',
        code: err.code,
        kind: names[err.code] || String(err.code),
        message:
          err.code === 3
            ? `Trình duyệt không giải mã được luồng này (${err.message || 'lỗi decode'}). Thử bật "Buộc transcode".`
            : `Lỗi phát video [${names[err.code] || err.code}]: ${err.message || 'không rõ'}`,
      });
    };
    this.video.addEventListener('error', this._onVideoError);
  }

  connect(url) {
    this.destroyed = false;
    this.onStatus({ state: 'connecting', message: 'Dang ket noi tới camera...' });

    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.startedAt = performance.now();
      this.onStatus({ state: 'connected', message: 'Dang cho khung hinh dau tien...' });
    };

    this.ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') {
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        if (msg.type === 'meta') {
          this.meta = msg;
          this.onStatus({ state: 'meta', message: null, meta: msg });
        } else if (msg.type === 'error') {
          this.onStatus({ state: 'error', message: msg.error });
          this.close();
        }
        return;
      }

      this.bytes += evt.data.byteLength;
      if (!this.mediaSource) {
        this._initMse(evt.data);
      } else {
        this.segments += 1;
        this._enqueue(evt.data);
      }
    };

    this.ws.onerror = () => {
      if (!this.destroyed) this.onStatus({ state: 'error', message: 'Loi ket noi WebSocket' });
    };

    this.ws.onclose = (evt) => {
      if (this.destroyed) return;
      this.onStatus({
        state: 'closed',
        message: evt.reason ? `Luong dong: ${evt.reason}` : 'Luong da dong',
      });
    };

    this.statsTimer = setInterval(() => this._emitStats(), 1000);
  }

  _initMse(initSegment) {
    const codec = codecFromInit(initSegment);
    const mime = `video/mp4; codecs="${codec}"`;

    if (!window.MediaSource) {
      this.onStatus({ state: 'error', message: 'Trinh duyet khong ho tro MediaSource' });
      return;
    }
    if (!MediaSource.isTypeSupported(mime)) {
      this.onStatus({
        state: 'error',
        message: `Trinh duyet khong phat duoc codec ${codec}. Hay dung Chrome/Edge, hoac bat transcode.`,
      });
      return;
    }

    this.codec = codec;
    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);

    this.mediaSource.addEventListener('sourceopen', () => {
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
      } catch (err) {
        this.onStatus({ state: 'error', message: `Khong tao duoc SourceBuffer: ${err.message}` });
        return;
      }
      this.sourceBuffer.mode = 'segments';
      this.sourceBuffer.addEventListener('updateend', () => this._drain());
      this.sourceBuffer.addEventListener('error', () =>
        this.onStatus({ state: 'error', message: 'SourceBuffer bao loi khi giai ma' })
      );
      this._enqueue(initSegment);
      this.onStatus({ state: 'buffering', message: 'Dang dem khung hinh...' });
    });
  }

  _enqueue(chunk) {
    this.queue.push(chunk);
    this._drain();
  }

  _drain() {
    const sb = this.sourceBuffer;
    if (this.fatal || this.video.error) return;
    if (!sb || sb.updating || !this.queue.length) return;
    if (this.mediaSource.readyState !== 'open') return;

    // Don bo dem cu de khong bi QuotaExceededError khi xem lau
    try {
      if (sb.buffered.length) {
        const end = sb.buffered.end(sb.buffered.length - 1);
        const start = sb.buffered.start(0);
        if (end - start > this.bufferWindow) {
          sb.remove(start, end - this.bufferWindow / 2);
          return; // doi updateend roi append tiep
        }
      }
    } catch {
      /* bo qua */
    }

    const chunk = this.queue.shift();
    try {
      sb.appendBuffer(chunk);
    } catch (err) {
      if (err.name === 'QuotaExceededError') {
        this.queue.unshift(chunk);
        try {
          const end = sb.buffered.end(sb.buffered.length - 1);
          sb.remove(sb.buffered.start(0), end - 2);
        } catch {
          /* bo qua */
        }
      } else {
        this.onStatus({ state: 'error', message: `Loi append: ${err.message}` });
      }
      return;
    }

    this._keepLive();
  }

  /** Keo con tro phat ve sat dau luong de giu do tre thap. */
  _keepLive() {
    const v = this.video;
    if (!v.buffered.length) return;
    const end = v.buffered.end(v.buffered.length - 1);
    if (v.paused && v.readyState >= 2) v.play().catch(() => {});
    const behind = end - v.currentTime;
    if (behind > this.maxLatency || v.currentTime === 0) {
      v.currentTime = Math.max(0, end - 0.15);
    }
  }

  _emitStats() {
    if (this.destroyed) return;
    const v = this.video;
    let latency = null;
    if (v.buffered.length) latency = v.buffered.end(v.buffered.length - 1) - v.currentTime;
    const elapsed = (performance.now() - this.startedAt) / 1000;
    this.onStats({
      kbps: elapsed > 0 ? Math.round((this.bytes * 8) / elapsed / 1000) : 0,
      latency,
      segments: this.segments,
      codec: this.codec || null,
      resolution: v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : null,
      queued: this.queue.length,
      meta: this.meta,
    });
  }

  close() {
    this.destroyed = true;
    this.video.removeEventListener('error', this._onVideoError);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.queue = [];
    if (this.ws) {
      try {
        this.ws.onmessage = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        /* ignore */
      }
    }
    this.sourceBuffer = null;
    this.mediaSource = null;
    try {
      this.video.pause();
      if (this.video.src) URL.revokeObjectURL(this.video.src);
      this.video.removeAttribute('src');
      this.video.load();
    } catch {
      /* ignore */
    }
  }
}

window.Fmp4Player = Fmp4Player;
