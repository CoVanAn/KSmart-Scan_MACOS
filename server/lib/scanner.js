'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const config = require('../config');
const net = require('./network');
const oui = require('./oui');
const { scanHostPorts, pool } = require('./portscan');
const { discoverHosts } = require('./discovery');
const { probeRtsp } = require('./rtsp');
const hik = require('./hikvision');

const DEVICE_TYPE = {
  HIKVISION: 'hikvision',
  CAMERA: 'camera',
  NORMAL: 'normal',
};

/**
 * Quan ly cac phien quet. Phat su kien de server day xuong WebSocket ngay khi
 * tim thay thiet bi, khong cho quet xong ca dai mang.
 */
class ScanManager extends EventEmitter {
  constructor() {
    super();
    this.scans = new Map(); // scanId -> scan state
    this.devices = new Map(); // ip -> device (ket qua moi nhat, dung chung giua cac lan quet)
    this.active = null;
  }

  getScan(scanId) {
    return this.scans.get(scanId) || null;
  }

  listDevices() {
    return net.sortIps([...this.devices.keys()]).map((ip) => this.devices.get(ip));
  }

  getDevice(ip) {
    return this.devices.get(ip) || null;
  }

  /** Gan thong tin xac thuc da luu vao device (khong chua mat khau). */
  annotate(ip, patch) {
    const dev = this.devices.get(ip);
    if (!dev) return null;
    Object.assign(dev, patch, { updatedAt: new Date().toISOString() });
    this.emit('event', { type: 'device', device: dev });
    return dev;
  }

  start(options = {}) {
    if (this.active && this.active.status === 'running') {
      const err = new Error('Đang có một phiên quét chạy. Hãy đợi hoặc huỷ phiên đó.');
      err.code = 'SCAN_BUSY';
      throw err;
    }

    const cidr = options.cidr;
    if (!cidr) throw new Error('Thiếu tham số cidr');

    const ports =
      Array.isArray(options.ports) && options.ports.length
        ? options.ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
        : config.scan.ports;

    const hosts = net.expandCidr(cidr, config.scan.maxHosts);

    const scan = {
      id: crypto.randomBytes(6).toString('hex'),
      cidr: net.parseCidr(cidr).cidr,
      iface: options.iface || null,
      ports,
      status: 'running',
      phase: 'discovery',
      method: null,
      total: hosts.length,
      done: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      notes: [],
      found: [],
      error: null,
      cancelled: false,
    };

    this.scans.set(scan.id, scan);
    this.active = scan;

    this._run(scan, hosts, options).catch((err) => {
      scan.status = 'error';
      scan.error = err.message;
      scan.finishedAt = new Date().toISOString();
      this.emit('event', { type: 'scan:error', scanId: scan.id, error: err.message });
    });

    return scan;
  }

  cancel(scanId) {
    const scan = scanId ? this.scans.get(scanId) : this.active;
    if (!scan || scan.status !== 'running') return false;
    scan.cancelled = true;
    return true;
  }

  _note(scan, message) {
    scan.notes.push(message);
    this.emit('event', { type: 'scan:note', scanId: scan.id, message });
  }

  _progress(scan) {
    this.emit('event', {
      type: 'scan:progress',
      scanId: scan.id,
      phase: scan.phase,
      done: scan.done,
      total: scan.total,
      found: scan.found.length,
    });
  }

  _upsert(scan, device) {
    const prev = this.devices.get(device.ip) || {};
    const merged = {
      ...prev,
      ...device,
      firstSeen: prev.firstSeen || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.devices.set(device.ip, merged);
    if (!scan.found.includes(device.ip)) scan.found.push(device.ip);
    this.emit('event', { type: 'device', scanId: scan.id, device: merged });
    return merged;
  }

  async _run(scan, hosts, options) {
    // ---- Buoc 1a: tim host dang song (ARP / ping sweep) ----
    this.emit('event', {
      type: 'scan:start',
      scanId: scan.id,
      cidr: scan.cidr,
      total: scan.total,
      ports: scan.ports,
    });

    const discovery = await discoverHosts(scan.cidr, hosts, {
      iface: scan.iface,
      useNmap: config.scan.useNmap,
      useArpScan: options.useArpScan ?? config.scan.useArpScan,
      pingConcurrency: config.scan.pingConcurrency,
      onNote: (msg) => this._note(scan, msg),
    });

    if (scan.cancelled) return this._finish(scan, 'cancelled');

    scan.method = discovery.method;
    this._note(
      scan,
      `Phát hiện ${discovery.hosts.length} host đang sống bằng phương pháp "${discovery.method}".`
    );

    // Quet cong tren host song truoc; neu discovery khong ra gi thi quet toan dai
    const targets = discovery.hosts.length
      ? net.sortIps(discovery.hosts.map((h) => h.ip))
      : hosts;
    const metaByIp = new Map(discovery.hosts.map((h) => [h.ip, h]));

    scan.phase = 'portscan';
    scan.total = targets.length;
    scan.done = 0;
    this._progress(scan);

    // ---- Buoc 1b: quet cong + dinh danh, ket qua bay len UI ngay ----
    await pool(targets, config.scan.hostConcurrency, async (ip) => {
      if (scan.cancelled) return;
      const meta = metaByIp.get(ip) || {};
      try {
        const device = await this._inspectHost(ip, meta, scan.ports);
        if (device) this._upsert(scan, device);
      } catch (err) {
        this._note(scan, `Lỗi khi kiểm tra ${ip}: ${err.message}`);
      } finally {
        scan.done += 1;
        if (scan.done % 4 === 0 || scan.done === scan.total) this._progress(scan);
      }
    });

    this._finish(scan, scan.cancelled ? 'cancelled' : 'done');
  }

  _finish(scan, status) {
    scan.status = status;
    scan.phase = 'finished';
    scan.finishedAt = new Date().toISOString();
    if (this.active === scan) this.active = null;

    const devices = scan.found.map((ip) => this.devices.get(ip)).filter(Boolean);
    const summary = {
      total: devices.length,
      hikvision: devices.filter((d) => d.type === DEVICE_TYPE.HIKVISION).length,
      cameras: devices.filter((d) => d.type === DEVICE_TYPE.CAMERA).length,
      normal: devices.filter((d) => d.type === DEVICE_TYPE.NORMAL).length,
      durationMs: new Date(scan.finishedAt) - new Date(scan.startedAt),
      method: scan.method,
    };
    scan.summary = summary;
    this.emit('event', { type: 'scan:done', scanId: scan.id, status, summary });
  }

  /** Do cong + dinh danh 1 host. Tra ve null neu host khong co dau hieu ton tai. */
  async _inspectHost(ip, meta, ports) {
    const openPorts = await scanHostPorts(ip, ports, {
      timeout: config.scan.portTimeout,
      concurrency: Math.min(ports.length, 16),
    });

    const alive = openPorts.length > 0 || !!meta.mac || meta.source === 'nmap' || meta.source === 'ping';
    if (!alive) return null;

    const mac = oui.normalizeMac(meta.mac) || null;
    const vendor = oui.lookupVendor(mac) || meta.vendorHint || null;

    const device = {
      ip,
      mac,
      vendor,
      vendorSource: oui.lookupVendor(mac) ? 'oui' : meta.vendorHint ? 'scan' : null,
      openPorts,
      discoveredBy: meta.source || 'portscan',
      type: DEVICE_TYPE.NORMAL,
      hostname: null,
      rtsp: null,
      isapi: null,
      deviceInfo: null,
      reasons: [],
      needsCredentials: false,
      hasCredentials: false,
    };

    const rtspPort = openPorts.find((p) => p === 554 || p === 8554);
    const cameraPortOpen = openPorts.some((p) => config.scan.cameraPorts.includes(p));

    // ---- RTSP probe ----
    if (rtspPort) {
      device.rtsp = await probeRtsp(ip, rtspPort, 2500);
      device.rtspPort = rtspPort;
      if (device.rtsp.rtsp) {
        device.type = DEVICE_TYPE.CAMERA;
        device.reasons.push(`Cổng ${rtspPort} trả lời giao thức RTSP`);
        if (device.rtsp.server) device.reasons.push(`RTSP Server: ${device.rtsp.server}`);
        if (/hikvision/i.test(device.rtsp.server || '') || /IP Camera|DS-/i.test(device.rtsp.realm || '')) {
          device.type = DEVICE_TYPE.HIKVISION;
        }
      }
    }

    // ---- ISAPI probe (xac dinh Hikvision) ----
    const httpCandidates = openPorts.filter((p) => config.scan.httpPorts.includes(p));
    if (cameraPortOpen || oui.isCameraVendor(vendor)) {
      for (const httpPort of httpCandidates.length ? httpCandidates : [80]) {
        const probe = await hik.probeAnonymous(ip, httpPort, { tls: httpPort === 443, timeout: 4000 });
        if (probe.isapi || probe.isHikvision) {
          device.isapi = { ...probe, port: httpPort, tls: httpPort === 443 };
          device.httpPort = httpPort;
          device.reasons.push(...probe.evidence);
          if (probe.isHikvision) {
            device.type = DEVICE_TYPE.HIKVISION;
            // Thiet bi tu khai bao qua ISAPI - dang tin hon nhieu so voi tra OUI,
            // vi bang OUI khong bao gio phu het cac dai MAC cua Hikvision/OEM.
            if (!device.vendor || device.vendorSource !== 'oui') {
              device.vendor = 'Hikvision';
              device.vendorSource = 'isapi';
            }
          } else if (device.type === DEVICE_TYPE.NORMAL) {
            device.type = DEVICE_TYPE.CAMERA;
          }
          if (probe.deviceInfo) device.deviceInfo = probe.deviceInfo;
          break;
        }
      }
    }

    if (openPorts.includes(8000) && device.type === DEVICE_TYPE.NORMAL) {
      device.type = DEVICE_TYPE.CAMERA;
      device.reasons.push('Cổng 8000 (SDK Hikvision) đang mở');
    }
    if (oui.isCameraVendor(vendor) && device.type === DEVICE_TYPE.NORMAL) {
      device.type = DEVICE_TYPE.CAMERA;
      device.reasons.push(`MAC thuộc dải của ${vendor}`);
    }
    if (vendor === 'Hikvision' && device.type === DEVICE_TYPE.CAMERA) {
      device.type = DEVICE_TYPE.HIKVISION;
    }

    device.needsCredentials =
      device.type !== DEVICE_TYPE.NORMAL && !device.deviceInfo;
    device.httpPort = device.httpPort || httpCandidates[0] || 80;
    device.rtspPort = device.rtspPort || (openPorts.includes(554) ? 554 : 554);

    return device;
  }
}

module.exports = { ScanManager, DEVICE_TYPE };
