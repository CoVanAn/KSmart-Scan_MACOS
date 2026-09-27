'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseAuthenticate(header) {
  if (!header) return null;
  const scheme = header.split(/\s+/)[0];
  const rest = header.slice(scheme.length).trim();
  const params = {};
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  }
  return { scheme: scheme.toLowerCase(), params };
}

function buildDigestHeader({ username, password, method, uri, params, nc, cnonce }) {
  const { realm = '', nonce = '', opaque, algorithm, qop } = params;
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  let qopVal = null;
  if (qop) {
    const opts = qop.split(',').map((s) => s.trim());
    qopVal = opts.includes('auth') ? 'auth' : opts[0];
  }

  const response = qopVal
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qopVal}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const bits = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (algorithm) bits.push(`algorithm=${algorithm}`);
  if (qopVal) bits.push(`qop=${qopVal}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (opaque) bits.push(`opaque="${opaque}"`);
  return `Digest ${bits.join(', ')}`;
}

function rawRequest({ host, port, path: reqPath, method = 'GET', headers = {}, tls = false, timeout = 6000, binary = false }) {
  return new Promise((resolve, reject) => {
    const mod = tls ? https : http;
    const req = mod.request(
      {
        host,
        port,
        path: reqPath,
        method,
        headers: { 'User-Agent': 'find-ip-device/1.0', Accept: '*/*', ...headers },
        rejectUnauthorized: false,
        timeout,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= 8 * 1024 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: binary ? buf : buf.toString('utf8'),
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET/POST co ho tro HTTP Digest va Basic (Hikvision ISAPI dung Digest mac dinh).
 * Tra ve { status, headers, body, authScheme, realm }.
 */
async function request(opts) {
  const { username, password } = opts;
  const first = await rawRequest(opts);
  const challenge = parseAuthenticate(first.headers['www-authenticate']);

  if (first.status !== 401 || !username) {
    return {
      ...first,
      authScheme: challenge ? challenge.scheme : null,
      realm: challenge ? challenge.params.realm : null,
    };
  }

  if (!challenge) return { ...first, authScheme: null, realm: null };

  let authorization;
  if (challenge.scheme === 'digest') {
    authorization = buildDigestHeader({
      username,
      password: password || '',
      method: opts.method || 'GET',
      uri: opts.path,
      params: challenge.params,
      nc: '00000001',
      cnonce: crypto.randomBytes(8).toString('hex'),
    });
  } else {
    authorization = `Basic ${Buffer.from(`${username}:${password || ''}`).toString('base64')}`;
  }

  const second = await rawRequest({ ...opts, headers: { ...(opts.headers || {}), Authorization: authorization } });
  return { ...second, authScheme: challenge.scheme, realm: challenge.params.realm };
}

module.exports = { request, rawRequest, parseAuthenticate, buildDigestHeader };
