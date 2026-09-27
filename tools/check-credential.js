'use strict';
/**
 * Kiem tra mot bo tai khoan camera - dung 1 lan thu cho ISAPI va 1 lan cho RTSP,
 * roi in ket luan ro rang.
 *
 *   node tools/check-credential.js <ip> <user> '<mat khau>' [--http 80] [--rtsp 554] [--path /duong/dan]
 *
 * LUU Y: Hikvision khoa tai khoan sau 5 lan sai (mac dinh 30 phut). Cong cu nay
 * co hoi xac nhan truoc khi gui, va canh bao neu camera bao dang bi khoa.
 *
 * Mat khau dua vao day phai la MAT KHAU THAT (khong phai dang %40%21 lay tu URL).
 * Neu ban co mot URL RTSP dang chay, giai ma phan mat khau truoc:
 *   node -e "console.log(decodeURIComponent('Vpp%40921%21'))"
 */
const readline = require('readline');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const hik = require(path.join(ROOT, 'server', 'lib', 'hikvision'));
const digest = require(path.join(ROOT, 'server', 'lib', 'digest'));
const { buildRtspUrl, maskUrl } = require(path.join(ROOT, 'server', 'lib', 'rtsp'));

function parseArgs(argv) {
  const pos = [];
  const opt = { http: 80, rtsp: 554, path: null, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--http') opt.http = Number(argv[++i]);
    else if (a === '--rtsp') opt.rtsp = Number(argv[++i]);
    else if (a === '--path') opt.path = argv[++i];
    else if (a === '--yes' || a === '-y') opt.yes = true;
    else pos.push(a);
  }
  return { ip: pos[0], user: pos[1], pass: pos[2] ?? '', opt };
}

const { ip, user, pass, opt } = parseArgs(process.argv.slice(2));

if (!ip || !user) {
  console.error(
    "Cach dung: node tools/check-credential.js <ip> <user> '<mat khau>' [--http 80] [--rtsp 554] [--path /...]"
  );
  process.exit(2);
}

const ask = (q) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });

/** Buoc nay KHONG gui mat khau -> khong tinh la mot lan dang nhap sai. */
async function probeFree() {
  const res = await digest.rawRequest({
    host: ip,
    port: opt.http,
    path: '/ISAPI/System/deviceInfo',
    timeout: 6000,
  });
  const ch = digest.parseAuthenticate(res.headers['www-authenticate']);
  return {
    status: res.status,
    scheme: ch ? ch.scheme : null,
    realm: ch ? ch.params.realm : null,
    stale: ch ? ch.params.stale : null,
    server: res.headers.server || null,
  };
}

function probeRtsp(url) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v:0',
       '-show_entries', 'stream=codec_name,width,height', '-of', 'json', '-i', url],
      { timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) {
          const text = String(stderr || err.message);
          resolve({ ok: false, unauthorized: /401|Unauthorized/i.test(text), detail: text.trim().split('\n')[0] });
          return;
        }
        let info = {};
        try {
          info = (JSON.parse(stdout).streams || [])[0] || {};
        } catch {
          /* bo qua */
        }
        resolve({ ok: true, info });
      }
    );
  });
}

(async () => {
  console.log(`\nCamera : ${ip}  (HTTP ${opt.http}, RTSP ${opt.rtsp})`);
  console.log(`Tai khoan: ${user}  |  mat khau: ${pass ? `${pass.length} ky tu` : '(rong)'}`);
  if (/%[0-9a-fA-F]{2}/.test(pass)) {
    console.log(
      `\n  ⚠  Mat khau chua chuoi kieu "%40" - co the ban dang dua dang DA URL-ENCODE.\n` +
        `     Dang da giai ma se la: ${decodeURIComponent(pass)}\n` +
        `     Cong cu nay can MAT KHAU THAT, khong phai dang lay tu URL.`
    );
  }

  console.log('\n[1/3] Kiem tra camera (khong gui mat khau, khong tinh la lan dang nhap sai)...');
  let free;
  try {
    free = await probeFree();
  } catch (err) {
    console.log(`  ✗ Khong ket noi duoc HTTP ${opt.http}: ${err.message}`);
    process.exit(1);
  }
  console.log(`  HTTP ${free.status} | auth: ${free.scheme || '-'} | realm: ${free.realm || '-'} | Server: ${free.server || '-'}`);
  if (free.stale && free.stale.toUpperCase() !== 'FALSE') {
    console.log('  ⚠  stale != FALSE - nonce da cu, camera co the dang o trang thai la.');
  }

  if (!opt.yes) {
    console.log(
      '\n  Hai buoc tiep theo se dung 2 lan dang nhap. Hikvision khoa tai khoan sau 5 lan sai\n' +
        '  (mac dinh 30 phut), va khi bi khoa thi MAT KHAU DUNG CUNG TRA VE 401.'
    );
    const ans = await ask('  Tiep tuc? [y/N] ');
    if (ans !== 'y' && ans !== 'yes') {
      console.log('  Da huy, khong gui lan dang nhap nao.');
      process.exit(0);
    }
  }

  console.log('\n[2/3] Thu ISAPI (HTTP Digest)...');
  let isapiOk = false;
  try {
    const info = await hik.getDeviceInfo(ip, opt.http, user, pass, { tls: opt.http === 443 });
    isapiOk = true;
    console.log(`  ✓ ISAPI OK - ${info.model || '?'} | SN ${info.serialNumber || '?'} | FW ${info.firmwareVersion || '?'}`);
  } catch (err) {
    console.log(`  ✗ ISAPI that bai: ${err.message}`);
  }

  console.log('\n[3/3] Thu RTSP...');
  const url = buildRtspUrl({
    ip,
    port: opt.rtsp,
    username: user,
    password: pass,
    channel: 1,
    stream: 'main',
    path: opt.path,
  });
  console.log(`  URL: ${maskUrl(url)}`);
  const rtsp = await probeRtsp(url);
  if (rtsp.ok) {
    console.log(`  ✓ RTSP OK - ${rtsp.info.codec_name} ${rtsp.info.width}x${rtsp.info.height}`);
  } else {
    console.log(`  ✗ RTSP that bai${rtsp.unauthorized ? ' (401 - sai tai khoan HOAC dang bi khoa)' : ''}: ${rtsp.detail}`);
  }

  console.log('\n--- KET LUAN ---');
  if (rtsp.ok) {
    console.log('  Xem duoc video. Nhap dung bo tai khoan nay vao form cua ung dung.');
    if (!isapiOk) {
      console.log('  (ISAPI tu choi nen se khong co model/serial/danh sach kenh - khong sao, van xem duoc.)');
    }
  } else if (isapiOk) {
    console.log('  Tai khoan DUNG (ISAPI chap nhan) nhung RTSP khong ra luong.');
    console.log('  Kiem tra: duong dan RTSP (--path), so kenh, hoac RTSP bi tat trong cau hinh camera.');
  } else {
    console.log('  Ca hai duong deu tu choi. Kha nang cao nhat, theo thu tu:');
    console.log('   1. Tai khoan dang BI KHOA -> doi 30 phut, hoac khoi dong lai camera roi thu 1 lan.');
    console.log('   2. Mat khau khong dung (neu lay tu URL thi phai URL-decode truoc).');
    console.log('   3. Ten dang nhap khong phai "' + user + '".');
  }
  console.log('');
  process.exit(rtsp.ok || isapiOk ? 0 : 1);
})().catch((err) => {
  console.error('Loi:', err.message);
  process.exit(2);
});
