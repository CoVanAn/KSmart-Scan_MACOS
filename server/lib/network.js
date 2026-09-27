'use strict';

const os = require('os');

function ipToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) throw new Error(`IP không hợp lệ: ${ip}`);
  let acc = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`IP không hợp lệ: ${ip}`);
    acc = acc * 256 + n;
  }
  return acc;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function netmaskToPrefix(netmask) {
  const n = ipToInt(netmask);
  let prefix = 0;
  for (let i = 31; i >= 0; i -= 1) {
    if ((n >>> i) & 1) prefix += 1;
    else break;
  }
  return prefix;
}

function parseCidr(cidr) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m) throw new Error(`CIDR không hợp lệ: ${cidr}`);
  const prefix = Number(m[2]);
  if (prefix < 8 || prefix > 32) throw new Error(`Prefix phải trong khoảng /8 - /32`);
  const addr = ipToInt(m[1]);
  const maskBits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (addr & maskBits) >>> 0;
  const broadcast = (network | (~maskBits >>> 0)) >>> 0;
  return { network, broadcast, prefix, cidr: `${intToIp(network)}/${prefix}` };
}

/** Tra ve danh sach IP host (bo network/broadcast voi prefix <= 30). */
function expandCidr(cidr, maxHosts) {
  const { network, broadcast, prefix } = parseCidr(cidr);
  let first = network;
  let last = broadcast;
  if (prefix <= 30) {
    first = network + 1;
    last = broadcast - 1;
  }
  const total = last - first + 1;
  if (maxHosts && total > maxHosts) {
    throw new Error(
      `Dải mạng quá lớn (${total} host). Tối đa ${maxHosts}. Hãy quét dải nhỏ hơn, ví dụ /24.`
    );
  }
  const hosts = [];
  for (let i = first; i <= last; i += 1) hosts.push(intToIp(i));
  return hosts;
}

function cidrOf(address, netmask) {
  const prefix = netmaskToPrefix(netmask);
  const { cidr } = parseCidr(`${address}/${prefix}`);
  return cidr;
}

/** Cac interface IPv4 dang hoat dong (bo loopback). */
function listInterfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      const family = typeof a.family === 'number' ? (a.family === 4 ? 'IPv4' : 'IPv6') : a.family;
      if (family !== 'IPv4' || a.internal) continue;
      let cidr;
      try {
        // Chuan hoa ve dia chi mang (os.networkInterfaces tra ve dia chi host)
        cidr = cidrOf(a.address, a.netmask);
      } catch {
        continue;
      }
      const prefix = Number(cidr.split('/')[1]);
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        mac: (a.mac || '').toLowerCase(),
        cidr,
        // Dai /24 de quet cho nhanh, ngay ca khi interface la /16
        scanCidr: prefix < 24 ? cidrOf(a.address, '255.255.255.0') : cidr,
      });
    }
  }
  return out;
}

/** Chi cho phep thao tac tren IP noi bo (RFC1918 + link-local + loopback). */
function isPrivate(ip) {
  const n = ipToInt(ip);
  return (
    (n >= ipToInt('127.0.0.0') && n <= ipToInt('127.255.255.255')) ||
    (n >= ipToInt('10.0.0.0') && n <= ipToInt('10.255.255.255')) ||
    (n >= ipToInt('172.16.0.0') && n <= ipToInt('172.31.255.255')) ||
    (n >= ipToInt('192.168.0.0') && n <= ipToInt('192.168.255.255')) ||
    (n >= ipToInt('169.254.0.0') && n <= ipToInt('169.254.255.255'))
  );
}

function sortIps(ips) {
  return [...ips].sort((a, b) => ipToInt(a) - ipToInt(b));
}

module.exports = {
  ipToInt,
  intToIp,
  netmaskToPrefix,
  parseCidr,
  expandCidr,
  cidrOf,
  listInterfaces,
  isPrivate,
  sortIps,
};
