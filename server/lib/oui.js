'use strict';

/**
 * Tra cuu nha san xuat theo 3 byte dau cua MAC (OUI).
 * Day chi la GOI Y de uu tien do cong - ket qua chinh xac den tu ISAPI probe.
 * Bo sung them prefix vao day neu ban gap thiet bi chua nhan dang duoc.
 */
const OUI = {
  // --- Hikvision (va OEM cua Hikvision) ---
  '44:19:b6': 'Hikvision',
  '4c:bd:8f': 'Hikvision',
  'bc:ad:28': 'Hikvision',
  'c0:56:e3': 'Hikvision',
  '28:57:be': 'Hikvision',
  '58:03:fb': 'Hikvision',
  '8c:e7:48': 'Hikvision',
  'a4:14:37': 'Hikvision',
  'e0:ba:ad': 'Hikvision',
  '54:c4:15': 'Hikvision',
  '24:0f:9b': 'Hikvision',
  '18:68:cb': 'Hikvision',
  '3c:1b:f8': 'Hikvision',
  '44:47:cc': 'Hikvision',
  '98:8b:0a': 'Hikvision',
  'ac:b9:2f': 'Hikvision',
  'b4:a3:82': 'Hikvision',
  'd4:e8:53': 'Hikvision',
  'f8:4d:fc': 'Hikvision',
  '68:e2:07': 'Hikvision',
  'ec:c8:9c': 'Hikvision',
  '1c:20:db': 'Hikvision',

  // --- Dahua ---
  '3c:ef:8c': 'Dahua',
  '4c:11:bf': 'Dahua',
  '90:02:a9': 'Dahua',
  'bc:32:5f': 'Dahua',
  'e0:50:8b': 'Dahua',
  '08:ee:8b': 'Dahua',
  '14:a7:8b': 'Dahua',
  '24:52:6a': 'Dahua',
  '38:af:29': 'Dahua',
  '9c:14:63': 'Dahua',
  'a0:bd:1d': 'Dahua',
  'fc:5f:49': 'Dahua',

  // --- Hang camera khac ---
  '00:40:8c': 'Axis',
  'ac:cc:8e': 'Axis',
  'b8:a4:4f': 'Axis',
  '48:ea:63': 'Uniview',
  '00:12:16': 'Uniview',
  '00:0f:7c': 'TP-Link (Tapo/Vigi)',
  'd8:07:b6': 'TP-Link',
  '54:af:97': 'TP-Link',
  '00:1a:4d': 'Reolink',
  'ec:71:db': 'Reolink',
  '9c:8e:cd': 'Amcrest',
  '00:80:f0': 'Panasonic',
  '00:0e:8f': 'Sercomm',
  '3c:e3:6b': 'Ezviz',
  '54:2b:8d': 'Ezviz',

  // --- Thiet bi thong thuong (de loc bot nhieu) ---
  '00:0c:29': 'VMware',
  '00:50:56': 'VMware',
  '08:00:27': 'VirtualBox',
  '52:54:00': 'QEMU/KVM',
  'b8:27:eb': 'Raspberry Pi',
  'dc:a6:32': 'Raspberry Pi',
  'e4:5f:01': 'Raspberry Pi',
  '2c:cf:67': 'Raspberry Pi',
};

const CAMERA_VENDORS = new Set([
  'Hikvision',
  'Dahua',
  'Axis',
  'Uniview',
  'Reolink',
  'Amcrest',
  'Ezviz',
  'TP-Link (Tapo/Vigi)',
]);

function normalizeMac(mac) {
  if (!mac) return null;
  const hex = String(mac).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

function lookupVendor(mac) {
  const norm = normalizeMac(mac);
  if (!norm) return null;
  return OUI[norm.slice(0, 8)] || null;
}

function isCameraVendor(vendor) {
  return !!vendor && CAMERA_VENDORS.has(vendor);
}

function isHikvisionMac(mac) {
  return lookupVendor(mac) === 'Hikvision';
}

module.exports = { OUI, normalizeMac, lookupVendor, isCameraVendor, isHikvisionMac };
