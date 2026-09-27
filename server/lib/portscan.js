'use strict';

const net = require('net');

/**
 * TCP connect scan thuan Node - khong can quyen root.
 * Tra ve true neu bat tay TCP thanh cong.
 */
function probePort(host, port, timeout = 900) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/** Chay cac task async voi gioi han so luong dong thoi. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** Do nhieu cong tren 1 host, tra ve mang cong dang mo. */
async function scanHostPorts(host, ports, { timeout = 900, concurrency = 16 } = {}) {
  const open = [];
  await pool(ports, concurrency, async (port) => {
    if (await probePort(host, port, timeout)) open.push(port);
  });
  return open.sort((a, b) => a - b);
}

module.exports = { probePort, scanHostPorts, pool };
