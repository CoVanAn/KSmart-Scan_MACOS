'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Kho tai khoan camera, ma hoa AES-256-GCM.
 * Khoa lay tu env CRED_KEY (hex 64 ky tu) hoac tu dong sinh vao data/.cred.key (chmod 600).
 */
class CredentialStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'credentials.enc');
    this.keyFile = path.join(dataDir, '.cred.key');
    this.map = new Map();
    this.key = null;
  }

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.key = this._loadKey();
    this._load();
    return this;
  }

  _loadKey() {
    const fromEnv = process.env.CRED_KEY;
    if (fromEnv) {
      const buf = Buffer.from(fromEnv.trim(), 'hex');
      if (buf.length !== 32) throw new Error('CRED_KEY phải là 64 ký tự hex (32 byte)');
      return buf;
    }
    if (fs.existsSync(this.keyFile)) {
      const buf = Buffer.from(fs.readFileSync(this.keyFile, 'utf8').trim(), 'hex');
      if (buf.length === 32) return buf;
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyFile, key.toString('hex'), { mode: 0o600 });
    return key;
  }

  _encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  }

  _decrypt(payload) {
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  _load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const obj = JSON.parse(this._decrypt(fs.readFileSync(this.file, 'utf8')));
      for (const [ip, cred] of Object.entries(obj)) this.map.set(ip, cred);
    } catch (err) {
      console.warn(`[cred] Không đọc được kho tài khoản (${err.message}). Bỏ qua file cũ.`);
    }
  }

  _persist() {
    const obj = Object.fromEntries(this.map);
    fs.writeFileSync(this.file, this._encrypt(JSON.stringify(obj)), { mode: 0o600 });
  }

  /** @returns {{username:string,password:string,httpPort:number,rtspPort:number,tls:boolean,savedAt:string}|null} */
  get(ip) {
    return this.map.get(ip) || null;
  }

  has(ip) {
    return this.map.has(ip);
  }

  set(ip, { username, password, httpPort = 80, rtspPort = 554, tls = false, rtspPath = null, legacy = false }) {
    const cred = {
      username: String(username),
      password: String(password ?? ''),
      httpPort: Number(httpPort) || 80,
      rtspPort: Number(rtspPort) || 554,
      tls: !!tls,
      rtspPath: rtspPath ? String(rtspPath) : null,
      legacy: !!legacy,
      savedAt: new Date().toISOString(),
    };
    this.map.set(ip, cred);
    this._persist();
    return cred;
  }

  remove(ip) {
    const ok = this.map.delete(ip);
    if (ok) this._persist();
    return ok;
  }

  /** Danh sach da che mat khau - an toan de tra ve frontend. */
  listSafe() {
    return [...this.map.entries()].map(([ip, c]) => ({
      ip,
      username: c.username,
      httpPort: c.httpPort,
      rtspPort: c.rtspPort,
      tls: c.tls,
      rtspPath: c.rtspPath || null,
      legacy: !!c.legacy,
      savedAt: c.savedAt,
    }));
  }
}

module.exports = { CredentialStore };
