'use strict';

/**
 * Tach luong fragmented-MP4 tu stdout cua ffmpeg thanh:
 *  - init segment : ftyp + moov   (gui 1 lan cho moi client moi)
 *  - media segment: [styp] + moof + mdat  (gui lien tuc)
 * MSE tren browser can dung thu tu nay de phat duoc.
 */
class Mp4Segmenter {
  constructor({ onInit, onSegment }) {
    this.onInit = onInit;
    this.onSegment = onSegment;
    this.buffer = Buffer.alloc(0);
    this.initParts = [];
    this.initDone = false;
    this.pending = []; // cac box dang gom cho 1 media segment
  }

  write(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    for (;;) {
      if (this.buffer.length < 8) return;

      let size = this.buffer.readUInt32BE(0);
      const type = this.buffer.toString('latin1', 4, 8);
      let headerSize = 8;

      if (size === 1) {
        // largesize 64-bit
        if (this.buffer.length < 16) return;
        const hi = this.buffer.readUInt32BE(8);
        const lo = this.buffer.readUInt32BE(12);
        size = hi * 4294967296 + lo;
        headerSize = 16;
      } else if (size === 0) {
        // box keo dai den het luong - khong the phan doan tiep
        return;
      }

      if (size < headerSize || size > 256 * 1024 * 1024) {
        // Luong bi lech - reset de tranh treo vo han
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < size) return;

      const box = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      this._handleBox(type, box);
    }
  }

  _handleBox(type, box) {
    if (!this.initDone) {
      if (type === 'ftyp' || type === 'moov') {
        this.initParts.push(box);
        if (type === 'moov') {
          this.initDone = true;
          this.onInit(Buffer.concat(this.initParts));
          this.initParts = [];
        }
        return;
      }
      // Box la truoc khi co moov -> bo qua
      return;
    }

    if (type === 'moof' || type === 'styp') {
      if (type === 'styp') {
        this.pending = [box];
      } else {
        // moof moi trong khi chua co mdat => day cai cu di
        this._flushIfComplete();
        this.pending.push(box);
      }
      return;
    }

    if (type === 'mdat') {
      this.pending.push(box);
      this._flush();
      return;
    }

    // sidx, free, skip... bo qua
  }

  _flushIfComplete() {
    if (this.pending.length) this.pending = [];
  }

  _flush() {
    if (!this.pending.length) return;
    const seg = Buffer.concat(this.pending);
    this.pending = [];
    this.onSegment(seg);
  }
}

module.exports = { Mp4Segmenter };
