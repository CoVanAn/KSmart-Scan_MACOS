'use strict';

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { pool } = require('./portscan');
const { normalizeMac } = require('./oui');

const execFileAsync = promisify(execFile);

async function hasCommand(cmd) {
  try {
    await execFileAsync('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ping sweep bang nmap (nhanh nhat, 1 process cho ca dai mang).
 * Neu chay duoi root, nmap dung ARP tren LAN va tra ve ca MAC.
 */
async function nmapPing(cidr, { timeout = 60000 } = {}) {
  const args = ['-sn', '-n', '-T4', '--max-retries', '1', '--host-timeout', '5s', cidr];
  const { stdout } = await execFileAsync('nmap', args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  const hosts = new Map();
  let current = null;
  for (const line of stdout.split('\n')) {
    const rep = /^Nmap scan report for (?:.*\()?(\d{1,3}(?:\.\d{1,3}){3})\)?\s*$/.exec(line.trim());
    if (rep) {
      current = rep[1];
      hosts.set(current, { ip: current, mac: null, vendorHint: null, source: 'nmap' });
      continue;
    }
    const mac = /^MAC Address:\s*([0-9A-Fa-f:]{17})\s*(?:\((.*)\))?/.exec(line.trim());
    if (mac && current) {
      const entry = hosts.get(current);
      entry.mac = normalizeMac(mac[1]);
      entry.vendorHint = mac[2] && mac[2] !== 'Unknown' ? mac[2] : null;
    }
  }
  return [...hosts.values()];
}

/** Ping sweep du phong bang lenh ping he thong. */
async function pingSweep(hosts, { concurrency = 128 } = {}) {
  const alive = [];
  await pool(hosts, concurrency, async (ip) => {
    const ok = await new Promise((resolve) => {
      const p = spawn('ping', ['-n', '-c', '1', '-W', '1', ip], { stdio: 'ignore' });
      const timer = setTimeout(() => p.kill('SIGKILL'), 2500);
      p.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      p.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (ok) alive.push({ ip, mac: null, vendorHint: null, source: 'ping' });
  });
  return alive;
}

/** Doc bang ARP cua kernel - khong can quyen dac biet. */
async function readNeighbors() {
  const out = new Map();
  const parse = (text, re) => {
    for (const line of text.split('\n')) {
      const m = re.exec(line);
      if (!m) continue;
      const mac = normalizeMac(m[2]);
      if (mac && mac !== '00:00:00:00:00:00') out.set(m[1], mac);
    }
  };
  try {
    const { stdout } = await execFileAsync('ip', ['-4', 'neigh', 'show'], { timeout: 5000 });
    parse(stdout, /^(\d{1,3}(?:\.\d{1,3}){3})\s+.*?lladdr\s+([0-9a-fA-F:]{17})/);
  } catch {
    try {
      const { stdout } = await execFileAsync('arp', ['-an'], { timeout: 5000 });
      parse(stdout, /\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-fA-F:]{17})/);
    } catch {
      /* khong lay duoc MAC - bo qua */
    }
  }
  return out;
}

/** ARP scan that su (chinh xac nhat) - can root hoac sudo NOPASSWD. */
async function arpScan(iface, { timeout = 30000 } = {}) {
  const run = async (cmd, args) => {
    const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  };
  const args = ['--localnet', '--retry=2', '--timeout=500'];
  if (iface) args.unshift(`--interface=${iface}`);

  let stdout;
  try {
    stdout = await run('arp-scan', args);
  } catch {
    stdout = await run('sudo', ['-n', 'arp-scan', ...args]);
  }

  const hosts = [];
  for (const line of stdout.split('\n')) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F:]{17})\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    hosts.push({
      ip: m[1],
      mac: normalizeMac(m[2]),
      vendorHint: m[3] && !/^\(Unknown\)$/i.test(m[3]) ? m[3].trim() : null,
      source: 'arp-scan',
    });
  }
  return hosts;
}

/**
 * Phat hien host dang song trong dai mang.
 * Uu tien: arp-scan (neu bat) -> nmap -sn -> ping sweep.
 * Sau do lam giau MAC tu bang ARP cua kernel.
 */
async function discoverHosts(cidr, hosts, opts = {}) {
  const { iface, useNmap = true, useArpScan = false, pingConcurrency = 128, onNote } = opts;
  const note = (msg) => onNote && onNote(msg);
  let found = [];
  let method = null;

  if (useArpScan && (await hasCommand('arp-scan'))) {
    try {
      found = await arpScan(iface);
      method = 'arp-scan';
    } catch (err) {
      note(`arp-scan thất bại (${err.message.split('\n')[0]}), chuyển sang phương án khác.`);
    }
  }

  if (!found.length && useNmap && (await hasCommand('nmap'))) {
    try {
      found = await nmapPing(cidr);
      method = 'nmap';
    } catch (err) {
      note(`nmap thất bại (${err.message.split('\n')[0]}), chuyển sang ping sweep.`);
    }
  }

  if (!found.length) {
    found = await pingSweep(hosts, { concurrency: pingConcurrency });
    method = 'ping';
  }

  // Loc ve dung dai nguoi dung yeu cau. Bat buoc phai co: `arp-scan --localnet`
  // quet ca subnet cua interface (co the khac dai duoc chon), va `nmap -sn` tra ve
  // ca dia chi network/broadcast - deu khong nam trong danh sach host da yeu cau.
  const allowed = new Set(hosts);
  const skipped = found.length;
  found = found.filter((h) => allowed.has(h.ip));
  if (skipped > found.length) {
    note(`Bỏ qua ${skipped - found.length} địa chỉ nằm ngoài dải yêu cầu.`);
  }

  // Lam giau MAC tu bang ARP (nmap/ping khong chay root se khong co MAC)
  const neigh = await readNeighbors();
  const byIp = new Map();
  for (const h of found) {
    if (!h.mac && neigh.has(h.ip)) h.mac = neigh.get(h.ip);
    byIp.set(h.ip, h);
  }
  // Bang ARP co the biet nhung host ma ping bi firewall chan
  for (const [ip, mac] of neigh) {
    if (byIp.has(ip) || !allowed.has(ip)) continue;
    byIp.set(ip, { ip, mac, vendorHint: null, source: 'arp-cache' });
  }

  return { hosts: [...byIp.values()], method };
}

module.exports = { hasCommand, nmapPing, pingSweep, readNeighbors, arpScan, discoverHosts };
