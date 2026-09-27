'use strict';
/**
 * Test dau-cuoi: dung "camera gia" (test/fake-camera.js) roi goi dung cac
 * REST endpoint va WebSocket ma trinh duyet se goi.
 *
 * Chay:  npm test
 * Khong can camera that.
 */
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const RTSP_PORT = 8554;
const ISAPI_PORT = 8081;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'find-ip-device-test-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;

const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

function waitPort(port, timeout = 20000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`cong ${port} khong mo sau ${timeout}ms`));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

async function req(p, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

(async () => {
  const camera = spawn('node', [path.join(__dirname, 'fake-camera.js')], {
    stdio: ['pipe', 'pipe', 'pipe'], // stdin la pipe -> camera tu thoat khi e2e chet
  });
  camera.stdout.on('data', (d) => process.stdout.write(`    [camera] ${d}`));
  camera.stderr.on('data', (d) => process.stdout.write(`    [camera!] ${d}`));

  const server = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, STREAM_IDLE_TIMEOUT: '1000' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => {
    const s = d.toString();
    if (!/Non-monotonic|bad cseq|non-existing PPS|decode_slice_header/.test(s)) {
      process.stdout.write(`    [srv!] ${s}`);
    }
  });

  const cleanup = async () => {
    camera.kill('SIGTERM'); // SIGTERM truoc: de fake-camera kip kill ffmpeg con cua no
    server.kill('SIGTERM');
    await sleep(600);
    camera.kill('SIGKILL');
    server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  };

  try {
    await waitPort(PORT);
    await waitPort(RTSP_PORT, 30000);
    await waitPort(ISAPI_PORT);

    console.log('\n=== 1. API co ban ===');
    const ifaces = await req('/api/interfaces');
    check('GET /api/interfaces', ifaces.status === 200 && Array.isArray(ifaces.data.interfaces),
      `${ifaces.data.interfaces?.length} card mang`);
    check('GET /api/devices rong luc dau',
      (await req('/api/devices')).data.devices?.length === 0);
    check('Tu choi IP public', (await req('/api/devices/8.8.8.8')).status === 403);
    check('Tu choi IP sai dinh dang', (await req('/api/devices/abc')).status === 400);

    console.log('\n=== 2. Xac thuc credential ===');
    const cred = await req('/api/devices/127.0.0.1/credentials', {
      method: 'POST',
      body: { username: 'u', password: 'p', httpPort: ISAPI_PORT, rtspPort: RTSP_PORT, rtspPath: '/live' },
    });
    check('POST credentials thanh cong', cred.status === 200 && cred.data.result?.rtspOk === true,
      `HTTP ${cred.status} · ${cred.data.result?.stream?.codec} ${cred.data.result?.stream?.width}x${cred.data.result?.stream?.height}`);

    // Day la ca da tung bi bug: ISAPI tra 401 nhung RTSP chay duoc.
    // Truoc khi sua, server thoat som o buoc ISAPI va tra 401 cho nguoi dung.
    check('ISAPI 401 KHONG chan duong RTSP (regression)',
      cred.status === 200 && cred.data.result?.isapiOk === false && cred.data.result?.rtspOk === true,
      `isapiCode=${cred.data.result?.isapiCode}`);

    const devs = await req('/api/devices');
    check('Credential duoc luu', devs.data.credentials?.some((c) => c.ip === '127.0.0.1'));
    check('Mat khau khong lo ra API', !JSON.stringify(devs.data).includes('"p"'));

    console.log('\n=== 3. Luong video qua WebSocket ===');
    const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));

    const openStream = (query) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/stream?${query}`);
        const out = { meta: null, binaries: [], error: null, first: 0 };
        const done = setTimeout(() => {
          ws.close();
          resolve(out);
        }, 20000);
        ws.on('message', (data, isBinary) => {
          if (!isBinary) {
            const m = JSON.parse(data.toString());
            if (m.type === 'meta') out.meta = m;
            if (m.type === 'error') {
              out.error = m.error;
              clearTimeout(done);
              ws.close();
              resolve(out);
            }
            return;
          }
          out.binaries.push(data.length);
          if (out.binaries.length === 1) out.first = data.length;
          if (out.binaries.length >= 12) {
            clearTimeout(done);
            ws.close();
            resolve(out);
          }
        });
        ws.on('error', (e) => {
          out.error = e.message;
          clearTimeout(done);
          resolve(out);
        });
      });

    const copy = await openStream('ip=127.0.0.1&channel=1&stream=main');
    check('Nhan duoc meta', !!copy.meta,
      copy.meta ? `codec=${copy.meta.codec} ${copy.meta.width}x${copy.meta.height}` : copy.error);
    check('H.264 -> copy, khong transcode', copy.meta?.transcode === false);
    check('Goi binary dau la init segment', copy.first > 300 && copy.first < 4000, `${copy.first} byte`);
    check('Nhan duoc >=12 media segment', copy.binaries.length >= 12,
      `${copy.binaries.length} goi / ${copy.binaries.reduce((a, b) => a + b, 0)} byte`);

    const streams = await req('/api/streams');
    check('URL trong /api/streams da che mat khau',
      JSON.stringify(streams.data).includes('***') && !JSON.stringify(streams.data).includes(':p@'));

    console.log('\n=== 4. Buoc transcode ===');
    const tc = await openStream('ip=127.0.0.1&channel=1&stream=main&transcode=1');
    check('Luong transcode chay duoc', tc.binaries.length >= 12, `${tc.binaries.length} goi`);
    check('meta bao transcode=true va forced=true',
      tc.meta?.transcode === true && tc.meta?.forced === true);

    console.log('\n=== 5. Don dep & tu choi ===');
    await sleep(3500);
    check('ffmpeg dung khi het nguoi xem',
      (await req('/api/streams')).data.streams?.length === 0);

    const noCred = await openStream('ip=10.99.99.99&channel=1&stream=main');
    check('WS tu choi IP chua co tai khoan', !!noCred.error, noCred.error);

    check('DELETE credentials',
      (await req('/api/devices/127.0.0.1/credentials', { method: 'DELETE' })).data.removed === true);
  } catch (err) {
    console.error('\nTEST CRASH:', err.message);
    fail += 1;
  } finally {
    await cleanup();
  }

  console.log(`\n=== KET QUA: ${pass} pass, ${fail} fail ===`);
  process.exit(fail ? 1 : 0);
})();
