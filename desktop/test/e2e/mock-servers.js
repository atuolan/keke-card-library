'use strict';
// 本地模拟服务：
//  1) SillyTavern：照 SillyTavern 1.19 的协议实现 Basic 认证、cookie-session（含 .sig 签名 cookie）、
//     csrf-sync（非 GET 请求必须带 X-CSRF-Token）、/api/characters/all、/api/characters/import、/characters/<file>。
//  2) OpenAI 兼容接口：/v1/chat/completions、/v1/models。
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readChara } = require('./fixtures');

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function readBody(req) {
  return new Promise((resolve) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });
}
function parseMultipart(buf, contentType) {
  const m = /boundary=([^;]+)/.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + m[1]);
  const fields = {}, files = {};
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    const start = pos + boundary.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    const head = buf.subarray(start + 2, headEnd).toString('utf8');
    const next = buf.indexOf(boundary, headEnd);
    const body = buf.subarray(headEnd + 4, next - 2);
    const name = /name="([^"]*)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename != null) files[name] = { filename, data: body }; else fields[name] = body.toString('utf8');
    pos = next;
  }
  return { fields, files };
}

function startSillyTavern({ charactersDir, basicUser, basicPassword }) {
  const secret = crypto.randomBytes(16).toString('hex');
  const COOKIE = 'session-e2e';
  const log = [];
  const sign = (v) => crypto.createHmac('sha1', secret).update(COOKIE + '=' + v).digest('base64').replace(/\//g, '_').replace(/\+/g, '-').replace(/=+$/, '');
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://x');
    const entry = { method: req.method, path: url.pathname, auth: req.headers.authorization || '', csrf: req.headers['x-csrf-token'] || '', cookie: req.headers.cookie || '', status: 0 };
    log.push(entry);
    const send = (status, data, type = 'application/json', extraHeaders = {}) => {
      entry.status = status;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...extraHeaders });
      res.end(buf);
    };
    // Basic 认证（basicAuthMiddleware）
    if (basicUser) {
      const want = 'Basic ' + Buffer.from(basicUser + ':' + basicPassword).toString('base64');
      if (req.headers.authorization !== want) return send(401, '<h1>Unauthorized</h1>', 'text/html', { 'WWW-Authenticate': 'Basic realm="SillyTavern", charset="UTF-8"' });
    }
    // cookie-session：值为 base64(JSON)，另有 <name>.sig 签名 cookie
    const cookies = parseCookies(req.headers.cookie);
    let session = {};
    if (cookies[COOKIE] && cookies[COOKIE + '.sig'] === sign(cookies[COOKIE])) {
      try { session = JSON.parse(Buffer.from(cookies[COOKIE], 'base64').toString('utf8')); } catch (e) { session = {}; }
    }
    const saveSession = () => {
      const v = Buffer.from(JSON.stringify(session)).toString('base64');
      return { 'Set-Cookie': [`${COOKIE}=${v}; path=/; samesite=lax; httponly`, `${COOKIE}.sig=${sign(v)}; path=/; samesite=lax; httponly`] };
    };
    if (req.method === 'GET' && url.pathname === '/moved') return send(302, '', 'text/plain', { Location: 'http://127.0.0.2:9/elsewhere' });
    if (req.method === 'GET' && url.pathname === '/csrf-token') {
      session.csrfToken = crypto.randomBytes(32).toString('hex');
      return send(200, { token: session.csrfToken }, 'application/json', saveSession());
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && (!session.csrfToken || req.headers['x-csrf-token'] !== session.csrfToken)) {
      return send(403, 'Invalid CSRF token. Please refresh the page and try again.', 'text/plain');
    }
    if (req.method === 'POST' && url.pathname === '/api/characters/all') {
      const list = [];
      for (const f of fs.readdirSync(charactersDir).filter((x) => x.endsWith('.png')).sort()) {
        const c = readChara(fs.readFileSync(path.join(charactersDir, f)));
        if (!c) continue;
        list.push({ shallow: true, name: c.data?.name || c.name, avatar: f, tags: c.data?.tags || [], data: { name: c.data?.name, tags: c.data?.tags || [], extensions: { fav: false, world: '' } } });
      }
      return send(200, list);
    }
    if (req.method === 'POST' && url.pathname === '/api/characters/import') {
      const mp = parseMultipart(body, req.headers['content-type']);
      if (!mp || !mp.files.avatar) return send(400, 'Bad Request', 'text/plain');
      entry.importFile = mp.files.avatar.filename; entry.fileType = mp.fields.file_type;
      const c = readChara(mp.files.avatar.data);
      if (!c) return send(200, { error: true });
      const fileName = String(c.data?.name || c.name).replace(/[\\/:*?"<>|]/g, '_');
      fs.writeFileSync(path.join(charactersDir, fileName + '.png'), mp.files.avatar.data);
      return send(200, { file_name: fileName });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/characters/')) {
      const f = path.join(charactersDir, path.basename(decodeURIComponent(url.pathname.slice('/characters/'.length))));
      if (!fs.existsSync(f)) return send(404, 'Not found', 'text/plain');
      return send(200, fs.readFileSync(f), 'image/png');
    }
    return send(404, 'Not found', 'text/plain');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, url: 'http://127.0.0.1:' + server.address().port })));
}

function startOpenAI() {
  const log = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    log.push({ method: req.method, path: req.url, auth: req.headers.authorization || '', body: body.toString('utf8') });
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/v1/models' }); res.end(); return; }
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'mock-model' }] })); return; }
    if (req.url.endsWith('/chat/completions')) {
      if (req.headers.authorization !== 'Bearer sk-e2e-key') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"bad key"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '模拟回复：收到' } }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, url: 'http://127.0.0.1:' + server.address().port })));
}

module.exports = { startSillyTavern, startOpenAI };
