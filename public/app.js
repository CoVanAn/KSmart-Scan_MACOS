'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  devices: new Map(), // ip -> device
  scanId: null,
  scanning: false,
  filter: 'all',
  streams: [],
  credTarget: null,
  videoTarget: null,
  player: null,
};

const el = {
  connState: $('connState'),
  ifaceSelect: $('ifaceSelect'),

  portsInput: $('portsInput'),
  scanBtn: $('scanBtn'),

  progressWrap: $('progressWrap'),
  progressBar: $('progressBar'),
  progressText: $('progressText'),
  progressPhase: $('progressPhase'),
  statusLine: $('statusLine'),
  themeBtn: $('themeBtn'),
  themeIcon: $('themeIcon'),
  deviceBody: $('deviceBody'),
  emptyState: $('emptyState'),
  credModal: $('credModal'),
  credForm: $('credForm'),
  credIp: $('credIp'),
  credMsg: $('credMsg'),
  credSubmit: $('credSubmit'),
  videoModal: $('videoModal'),
  videoEl: $('videoEl'),
  videoIp: $('videoIp'),
  videoOverlay: $('videoOverlay'),
  videoStatus: $('videoStatus'),
  videoStats: $('videoStats'),
  channelSelect: $('channelSelect'),
  streamToggle: $('streamToggle'),
  snapshotBtn: $('snapshotBtn'),
};

// ----------------------------------------------------------------- tien ich

async function api(path, options = {}) {
  const isTauri = window.__TAURI_INTERNALS__ || window.__TAURI__;
  const base = isTauri ? 'http://127.0.0.1:3000' : '';
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Thay cho panel "Nhat ky quet": chi hien thong bao moi nhat tren mot dong,
 * tu an sau vai giay. Lich su day du van con o console.
 */
let statusTimer = null;
function log(message, kind = '') {
  console.log(`[${new Date().toLocaleTimeString('vi-VN')}] ${message}`);
  el.statusLine.textContent = message;
  el.statusLine.className = `status-line ${kind}`;
  el.statusLine.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.statusLine.hidden = true;
  }, kind === 'err' ? 12000 : 6000);
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------ sang / toi

const THEME_KEY = 'find-ip-device:theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Icon la thao tac se xay ra khi bam, khong phai trang thai hien tai
  el.themeIcon.textContent = theme === 'light' ? '🌙' : '☀️';
  el.themeBtn.title = theme === 'light' ? 'Chuyển sang giao diện tối' : 'Chuyển sang giao diện sáng';
}

function initTheme() {
  let theme = null;
  try {
    theme = localStorage.getItem(THEME_KEY);
  } catch {
    /* trinh duyet chan localStorage */
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  applyTheme(theme);
}

el.themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* khong luu duoc thi thoi */
  }
});

// ----------------------------------------------------------- khoi tao form

async function loadInterfaces() {
  try {
    const { interfaces, suggested, defaultPorts } = await api('/api/interfaces');
    el.ifaceSelect.innerHTML = '';
    for (const i of interfaces) {
      const opt = document.createElement('option');
      opt.value = i.scanCidr;
      opt.dataset.iface = i.name;
      let displayName = i.name;
      if (/^\{[0-9A-F\-]+\}$/i.test(i.name)) {
        displayName = 'Card';
      }
      opt.textContent = `${displayName} — ${i.address} (${i.scanCidr})`;
      el.ifaceSelect.append(opt);
    }
    if (!interfaces.length) {
      const opt = document.createElement('option');
      opt.textContent = 'Không tìm thấy card mạng';
      el.ifaceSelect.append(opt);
    }
    if (suggested) {
      el.ifaceSelect.value = suggested.scanCidr;
    }
    el.portsInput.value = (defaultPorts || []).join(',');
  } catch (err) {
    log(`Không tải được danh sách card mạng: ${err.message}`, 'err');
  }
}



// -------------------------------------------------------------- WebSocket

function connectEvents() {
  const isTauri = window.__TAURI_INTERNALS__ || window.__TAURI__;
  const proto = isTauri ? 'ws' : (location.protocol === 'https:' ? 'wss' : 'ws');
  const host = isTauri ? '127.0.0.1:3000' : location.host;
  const ws = new WebSocket(`${proto}://${host}/ws/events`);

  ws.onopen = () => {
    el.connState.className = 'conn online';
    el.connState.innerHTML = '<span class="dot"></span><span>Đã kết nối</span>';
  };

  ws.onclose = () => {
    el.connState.className = 'conn offline';
    el.connState.innerHTML = '<span class="dot"></span><span>Mất kết nối — thử lại…</span>';
    setTimeout(connectEvents, 2000);
  };

  ws.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    handleEvent(msg);
  };
}

function handleEvent(msg) {
  switch (msg.type) {
    case 'snapshot':
      state.devices.clear();
      for (const d of msg.devices || []) state.devices.set(d.ip, d);
      state.streams = msg.streams || [];
      if (msg.scan && msg.scan.status === 'running') setScanning(true, msg.scan.id);
      render();
      break;

    case 'scan:start':
      state.devices.clear();
      render();
      state.scanId = msg.scanId;
      setScanning(true, msg.scanId);
      log(`Bắt đầu quét ${msg.cidr} — ${msg.total} địa chỉ, cổng: ${msg.ports.join(', ')}`);
      break;

    case 'scan:note':
      log(msg.message);
      break;

    case 'scan:progress':
      updateProgress(msg);
      break;

    case 'device':
      state.devices.set(msg.device.ip, msg.device);
      render();
      break;

    case 'scan:done': {
      setScanning(false);
      const s = msg.summary || {};
      log(
        msg.status === 'cancelled'
          ? 'Đã huỷ quét.'
          : `Hoàn tất sau ${((s.durationMs || 0) / 1000).toFixed(1)}s — ${s.total} thiết bị, ${s.hikvision} Hikvision, ${s.cameras} nghi ngờ camera.`,
        msg.status === 'cancelled' ? '' : 'ok'
      );
      break;
    }

    case 'scan:error':
      setScanning(false);
      log(`Lỗi quét: ${msg.error}`, 'err');
      break;
  }
}

function setScanning(on, scanId) {
  state.scanning = on;
  if (scanId) state.scanId = scanId;
  el.scanBtn.disabled = on;
  el.scanBtn.textContent = on ? 'Đang quét…' : 'Bắt đầu quét';
  el.progressWrap.hidden = !on;
  if (!on) el.progressBar.style.width = '0%';
}

function updateProgress(msg) {
  el.progressWrap.hidden = false;
  const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
  el.progressBar.style.width = `${pct}%`;
  el.progressText.textContent = `${msg.done}/${msg.total} địa chỉ · ${msg.found} thiết bị`;
  el.progressPhase.textContent =
    msg.phase === 'discovery' ? 'Đang dò host sống…' : msg.phase === 'portscan' ? 'Đang dò cổng & định danh…' : '';
}

// ------------------------------------------------------------------ render

function typeInfo(d) {
  if (d.type === 'hikvision') return { cls: 'hik', label: 'Hikvision', row: 'hik-row' };
  if (d.type === 'camera') return { cls: 'cam', label: 'Nghi ngờ camera', row: 'cam-row' };
  return { cls: 'normal', label: 'Thiết bị thường', row: '' };
}

function deviceMatchesFilter(d) {
  if (state.filter === 'all') return true;
  if (state.filter === 'camera') return d.type === 'hikvision' || d.type === 'camera';
  return d.type === 'normal';
}

function render() {
  const all = [...state.devices.values()].sort((a, b) => {
    const na = a.ip.split('.').map(Number);
    const nb = b.ip.split('.').map(Number);
    for (let i = 0; i < 4; i += 1) if (na[i] !== nb[i]) return na[i] - nb[i];
    return 0;
  });

  $('statTotal').textContent = all.length;
  $('statHik').textContent = all.filter((d) => d.type === 'hikvision').length;
  $('statCam').textContent = all.filter((d) => d.type === 'camera').length;
  $('statNormal').textContent = all.filter((d) => d.type === 'normal').length;


  const rows = all.filter(deviceMatchesFilter);
  el.emptyState.hidden = rows.length > 0;
  el.deviceBody.innerHTML = rows.map(renderRow).join('');
}

function renderRow(d) {
  const t = typeInfo(d);
  const isCam = d.type !== 'normal';
  const ports = (d.openPorts || [])
    .map((p) => `<span class="port ${[554, 8000, 8554].includes(p) ? 'hot' : ''}">${p}</span>`)
    .join('');

  // Cot "Thong tin" chi lay MOT dinh danh tot nhat + do phan giai neu da biet.
  // Phan chi tiet (MAC, hang, ly do phan loai) chuyen vao tooltip o cot IP.
  const info = [];
  const label =
    d.deviceInfo?.model || d.rtsp?.server || d.isapi?.realm || d.vendor || null;
  if (label) info.push(esc(label));
  if (d.streamInfo?.codec) {
    info.push(`${d.streamInfo.codec.toUpperCase()} ${d.streamInfo.width}×${d.streamInfo.height}`);
  }

  const tip = [
    d.mac ? `MAC: ${d.mac}` : null,
    d.vendor ? `Hãng: ${d.vendor}${d.vendorSource === 'isapi' ? ' (theo ISAPI)' : ''}` : null,
    d.discoveredBy ? `Tìm thấy qua: ${d.discoveredBy}` : null,
    ...(d.reasons || []),
  ]
    .filter(Boolean)
    .join('\n');

  const credBadge = d.hasCredentials
    ? '<span class="badge ok">Đã có tài khoản</span>'
    : isCam
      ? '<span class="badge lock">Cần mật khẩu</span>'
      : '';

  const actions = [];
  if (isCam) {
    if (d.hasCredentials) {
      actions.push(`<button class="tiny primary" data-act="view" data-ip="${d.ip}">Xem</button>`);
      actions.push(`<button class="tiny" data-act="cred" data-ip="${d.ip}">Sửa</button>`);
      actions.push(`<button class="tiny" data-act="forget" data-ip="${d.ip}">Xoá</button>`);
    } else {
      actions.push(`<button class="tiny primary" data-act="cred" data-ip="${d.ip}">Kết nối</button>`);
    }
  }

  return `
    <tr class="${t.row}">
      <td><div class="ip" title="${esc(tip)}">${d.ip}</div></td>
      <td><div class="ports">${ports || '<span class="muted">—</span>'}</div></td>
      <td><span class="badge ${t.cls}">${t.label}</span> ${credBadge}</td>
      <td><div class="muted info-cell">${info.join(' · ') || '—'}</div></td>
      <td class="right"><div class="row-actions">${actions.join('')}</div></td>
    </tr>`;
}

// ------------------------------------------------------------- thao tac quet

el.scanBtn.addEventListener('click', async () => {
  const cidr = el.ifaceSelect.value;
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr)) {
    log(`Dải IP "${cidr}" không đúng định dạng CIDR (ví dụ: 192.168.100.0/24).`, 'err');
    return;
  }
  const ports = el.portsInput.value
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean);
  const iface = el.ifaceSelect.selectedOptions[0]?.dataset.iface;
  try {
    setScanning(true);
    await api('/api/scan', {
      method: 'POST',
      body: { cidr, ports, iface },
    });
  } catch (err) {
    setScanning(false);
    log(`Không bắt đầu được: ${err.message}`, 'err');
  }
});



document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.filter = chip.dataset.filter;
    render();
  });
});

el.deviceBody.addEventListener('click', async (evt) => {
  const btn = evt.target.closest('button[data-act]');
  if (!btn) return;
  const { act, ip } = btn.dataset;
  if (act === 'cred') openCredModal(ip);
  if (act === 'view') openVideoModal(ip);
  if (act === 'forget') {
    if (!confirm(`Xoá tài khoản đã lưu của ${ip}?`)) return;
    await api(`/api/devices/${ip}/credentials`, { method: 'DELETE' }).catch(() => {});
    log(`Đã xoá tài khoản của ${ip}.`);
  }
});

// ------------------------------------------------- Bước 2: popup tai khoan

function openCredModal(ip) {
  const d = state.devices.get(ip) || {};
  state.credTarget = ip;
  el.credIp.textContent = ip;
  el.credMsg.textContent = '';
  el.credMsg.className = 'form-msg';
  el.credForm.httpPort.value = d.httpPort || 80;
  el.credForm.rtspPort.value = d.rtspPort || 554;
  el.credForm.password.value = '';
  el.credForm.rtspPath.value = '';
  el.credModal.hidden = false;
  setTimeout(() => el.credForm.password.focus(), 50);
}

el.credForm.addEventListener('submit', async (evt) => {
  evt.preventDefault();
  const ip = state.credTarget;
  const fd = new FormData(el.credForm);
  el.credSubmit.disabled = true;
  el.credMsg.className = 'form-msg';
  el.credMsg.textContent = 'Đang xác thực qua ISAPI và RTSP…';

  try {
    const { result } = await api(`/api/devices/${ip}/credentials`, {
      method: 'POST',
      body: {
        username: fd.get('username'),
        password: fd.get('password') || '',
        httpPort: Number(fd.get('httpPort')),
        rtspPort: Number(fd.get('rtspPort')),
        rtspPath: (fd.get('rtspPath') || '').trim() || null,
        save: fd.get('save') === 'on',
      },
    });
    el.credMsg.className = 'form-msg ok';
    const bits = [];
    if (result.deviceInfo?.model) bits.push(result.deviceInfo.model);
    if (result.stream?.codec) bits.push(`${result.stream.codec} ${result.stream.width}x${result.stream.height}`);
    el.credMsg.textContent = `Thành công${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
    log(`Xác thực ${ip} thành công${bits.length ? `: ${bits.join(' · ')}` : ''}.`, 'ok');
    setTimeout(() => {
      el.credModal.hidden = true;
      openVideoModal(ip);
    }, 700);
  } catch (err) {
    el.credMsg.className = 'form-msg err';
    el.credMsg.textContent = err.message;
  } finally {
    el.credSubmit.disabled = false;
  }
});

// ----------------------------------------------- Bước 3/4: popup xem video

async function openVideoModal(ip) {
  state.videoTarget = { ip, channel: 1, stream: 'main', transcode: false };
  el.videoIp.textContent = ip;
  el.videoModal.hidden = false;
  el.videoStats.textContent = '—';

  // Danh sach kenh: NVR co nhieu kenh, camera don chi co 1
  el.channelSelect.innerHTML = '<option value="1">Kênh 1</option>';
  try {
    const { channels } = await api(`/api/devices/${ip}/channels`);
    const unique = [...new Map((channels || []).map((c) => [c.channel, c])).values()];
    if (unique.length) {
      el.channelSelect.innerHTML = unique
        .map((c) => `<option value="${c.channel}">${esc(c.name || `Kênh ${c.channel}`)}</option>`)
        .join('');
    }
  } catch {
    /* giu mac dinh 1 kenh */
  }

  startStream();
}

function setVideoOverlay(message, isError, showRetry) {
  const retry = $('overlayRetry');
  if (retry) retry.remove();

  if (!message) {
    el.videoOverlay.hidden = true;
    return;
  }
  el.videoOverlay.hidden = false;
  el.videoOverlay.classList.toggle('error', !!isError);
  el.videoStatus.textContent = message;

  // Chi de xuat mot lan: neu dang transcode roi ma van loi thi nut nay vo nghia
  if (showRetry && !state.videoTarget?.transcode) {
    const btn = document.createElement('button');
    btn.id = 'overlayRetry';
    btn.className = 'primary overlay-retry';
    btn.textContent = 'Thử lại với transcode';
    btn.addEventListener('click', () => {
      state.videoTarget.transcode = true;
      startStream();
    });
    el.videoOverlay.append(btn);
  }
}

function startStream() {
  const t = state.videoTarget;
  if (!t) return;

  if (state.player) state.player.close();
  setVideoOverlay('Đang kết nối tới camera…', false);

  const isTauri = window.__TAURI_INTERNALS__ || window.__TAURI__;
  const proto = isTauri ? 'ws' : (location.protocol === 'https:' ? 'wss' : 'ws');
  const host = isTauri ? '127.0.0.1:3000' : location.host;
  const params = new URLSearchParams({ ip: t.ip, channel: String(t.channel), stream: t.stream });
  if (t.transcode) params.set('transcode', '1');
  const url = `${proto}://${host}/ws/stream?${params}`;

  let fatal = false;
  state.player = new Fmp4Player(el.videoEl, {
    onStatus: ({ state: s, message, code }) => {
      if (s === 'fatal') {
        fatal = true;
        // Chi de xuat transcode khi loi la do giai ma (code 3)
        setVideoOverlay(message, true, code === 3);
      } else if (s === 'error') setVideoOverlay(message, true);
      else if (s === 'closed') {
        if (!fatal) setVideoOverlay(message || 'Luồng đã dừng', true);
      } else if (message) setVideoOverlay(message, false);
    },
    onStats: (st) => {
      if (st.segments > 0 && !fatal) setVideoOverlay(null);
      const bits = [];
      if (st.resolution) bits.push(st.resolution);
      if (st.codec) bits.push(st.codec);
      if (st.meta?.transcode) {
        bits.push(st.meta.forced ? 'transcode (buộc)' : `transcode ${(st.meta.codec || '').toUpperCase()}→H.264`);
      }
      bits.push(`${st.kbps} kbps`);
      if (st.latency !== null && Number.isFinite(st.latency)) bits.push(`trễ ${st.latency.toFixed(2)}s`);
      el.videoStats.textContent = bits.join(' · ');
    },
  });

  state.player.connect(url);
}

el.channelSelect.addEventListener('change', () => {
  if (!state.videoTarget) return;
  state.videoTarget.channel = Number(el.channelSelect.value) || 1;
  // Luong khac co the la codec khac -> bo ep transcode, de server tu quyet dinh
  state.videoTarget.transcode = false;
  startStream();
});

el.streamToggle.addEventListener('click', (evt) => {
  const btn = evt.target.closest('button[data-stream]');
  if (!btn || !state.videoTarget) return;
  el.streamToggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.videoTarget.stream = btn.dataset.stream;
  state.videoTarget.transcode = false;
  startStream();
});



// ------------------------------------------------------------------ dong modal

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

document.querySelectorAll('.modal').forEach((modal) => {
  modal.addEventListener('click', (evt) => {
    if (evt.target === modal) closeModal(modal.id);
  });
});

document.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Escape') return;
  if (!el.videoModal.hidden) closeModal('videoModal');
  else if (!el.credModal.hidden) closeModal('credModal');
});

function closeModal(id) {
  $(id).hidden = true;
  if (id === 'videoModal') {
    if (state.player) state.player.close();
    state.player = null;
    state.videoTarget = null;
    el.videoStats.textContent = '—';
  }
}

// ------------------------------------------------------------------ khoi dong

initTheme();
loadInterfaces();
connectEvents();

