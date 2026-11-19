'use strict';
// StHttpBridge —— 对应 MainActivity.StHttpBridge（SillyTavern 酒馆互通）。
// cookie 由独立的内存 session 管理（与 Java 内存 CookieManager 一样，重启即清空）。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const U = require('../util');
const { httpRequest } = require('../http');
const { LiteListParser } = require('../litelist');

const INLINE_MAX = 4 * 1024 * 1024;
const SPILL_RE = /^st_(resp|list)_\d+_\d+\.tmp$/;

function createStHttpBridge(ctx) {
  let basicOrigin = '', basicValue = '';
  let uploadBuf = [];
  let uploadSize = 0;
  let spillSeq = 0;
  const cacheDir = () => { fs.mkdirSync(ctx.paths.cache, { recursive: true }); return ctx.paths.cache; };
  const spillName = (kind) => path.join(cacheDir(), `st_${kind}_${Date.now()}_${++spillSeq}.tmp`);

  function originOf(url) { const u = new URL(url); return u.protocol.replace(/:$/, '') + '://' + u.host; }
  function baseHeaders(url, csrf, extra) {
    const h = { Accept: 'application/json', ...(extra || {}) };
    let follow = true;
    try {
      if (basicValue && originOf(url) === basicOrigin) { h.Authorization = basicValue; follow = false; }
    } catch (e) { /* URL 无效时由请求本身报错 */ }
    if (csrf) h['X-CSRF-Token'] = csrf;
    return { headers: h, follow };
  }
  // Java: msg.replace("\\","\\\\").replace("\"","'") 后 base64
  const errJson = (e) => JSON.stringify({ status: -1, b64: U.b64utf8(U.errMsg(e).replace(/\\/g, '\\\\').replace(/"/g, "'")) });
  const spillToken = (p) => U.b64utf8(p);

  async function doRequest(method, url, csrf, body) {
    let spill = null, spillFh = null;
    try {
      url = String(url);
      const { headers, follow } = baseHeaders(url, csrf, body ? { 'Content-Type': 'application/json; charset=utf-8' } : null);
      const mem = [];
      let memSize = 0, total = 0;
      const r = await httpRequest({
        method, url, session: ctx.sessions.st, cookies: true, headers, followRedirects: follow,
        body: body ? Buffer.from(String(body), 'utf8') : null,
        connectTimeout: 20000, readTimeout: 30000,
        onData(chunk) {
          total += chunk.length;
          if (!spill && memSize + chunk.length > INLINE_MAX) {
            // 超过 4MB：已读内容写入临时文件，之后一律落盘，不再占内存
            spill = spillName('resp');
            spillFh = fs.openSync(spill, 'w');
            for (const m of mem) fs.writeSync(spillFh, m);
            mem.length = 0; memSize = 0;
          }
          if (spill) fs.writeSync(spillFh, chunk);
          else { mem.push(chunk); memSize += chunk.length; }
        },
      });
      if (spill) {
        fs.closeSync(spillFh); spillFh = null;
        return JSON.stringify({ status: r.status, spill: spillToken(spill), size: total });
      }
      return JSON.stringify({ status: r.status, b64: U.b64(Buffer.concat(mem)) });
    } catch (e) {
      if (spillFh != null) { try { fs.closeSync(spillFh); } catch (x) { /* ignore */ } }
      if (spill) await fsp.rm(spill, { force: true }).catch(() => {});
      return errJson(e);
    }
  }

  /** multipart 上传和 postRaw：响应按 UTF-8 文本读回再 base64（与 Java 相同）。 */
  async function postBytes(url, csrf, contentType, bodyBytes, limit) {
    try {
      url = String(url);
      const { headers, follow } = baseHeaders(url, csrf, { 'Content-Type': contentType });
      const parts = [];
      let total = 0, tooLarge = false;
      const r = await httpRequest({
        method: 'POST', url, session: ctx.sessions.st, cookies: true, headers, followRedirects: follow,
        body: bodyBytes, connectTimeout: 30000, readTimeout: 60000,
        onData(chunk) {
          total += chunk.length;
          if (limit && total > limit) { tooLarge = true; throw new Error('响应过大'); }
          parts.push(chunk);
        },
      }).catch((e) => { if (tooLarge) return null; throw e; });
      if (tooLarge) return JSON.stringify({ status: -2, b64: U.b64utf8('响应过大') });
      const text = Buffer.concat(parts).toString('utf8');
      return JSON.stringify({ status: r.status, b64: U.b64utf8(text) });
    } catch (e) {
      return JSON.stringify({ status: -1, b64: U.b64utf8(U.errMsg(e).replace(/\\/g, '\\\\').replace(/"/g, "'")) });
    }
  }

  function multipart(fileName, fileBytes) {
    const boundary = 'KakuJavaBound' + Date.now();
    // 文件名进入请求头：去掉引号和换行，防止头部注入
    const safeName = String(fileName == null ? 'card.png' : fileName).replace(/["\r\n]/g, '_');
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="${safeName}"\r\nContent-Type: image/png\r\n\r\n`;
    const body = Buffer.concat([Buffer.from(head, 'utf8'), fileBytes, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
    return { boundary, body };
  }

  async function resolveSpill(pathB64) {
    const p = Buffer.from(String(pathB64), 'base64').toString('utf8');
    if (!SPILL_RE.test(path.basename(p)) || !(await U.isDirectChild(ctx.paths.cache, p))) throw new Error('无效的临时文件');
    return p;
  }

  const methods = {
    setBasicAuth(origin, username, password) {
      try {
        basicOrigin = originOf(String(origin));
        basicValue = (username == null || String(username).length === 0) ? '' : 'Basic ' + U.b64utf8(String(username) + ':' + (password == null ? '' : String(password)));
      } catch (e) { basicOrigin = ''; basicValue = ''; }
    },
    get(url, csrf) { return doRequest('GET', url, U.toStr(csrf), null); },
    post(url, csrf, body) { return doRequest('POST', url, U.toStr(csrf), U.toStr(body)); },
    put(url, csrf, body) { return doRequest('PUT', url, U.toStr(csrf), U.toStr(body)); },
    del(url, csrf) { return doRequest('DELETE', url, U.toStr(csrf), null); },

    async readSpillChunk(pathB64, offset, len) {
      try {
        const p = await resolveSpill(pathB64);
        const n = Math.min(Math.max(0, U.toInt(len)), 8 * 1024 * 1024);
        const b = await U.readAt(p, Math.max(0, U.toInt(offset)), n);
        if (b.length <= 0) return '{"n":0,"b64":""}';
        return JSON.stringify({ n: b.length, b64: U.b64(b) });
      } catch (e) {
        return JSON.stringify({ n: -1, err: U.errMsg(e).replace(/\\/g, '\\\\').replace(/"/g, "'") });
      }
    },
    async deleteSpill(pathB64) {
      try { await fsp.rm(await resolveSpill(pathB64), { force: true }); } catch (e) { /* ignore */ }
    },

    async fetchCharListLite(url, csrf, body) {
      const outFile = spillName('list');
      let fh = null;
      try {
        url = String(url); csrf = U.toStr(csrf); body = U.toStr(body);
        const { headers, follow } = baseHeaders(url, csrf, body ? { 'Content-Type': 'application/json; charset=utf-8' } : null);
        let parser = null, status = 0, writeErr = null;
        const r = await httpRequest({
          method: 'POST', url, session: ctx.sessions.st, cookies: true, headers, followRedirects: follow,
          body: body ? Buffer.from(body, 'utf8') : null, connectTimeout: 20000, readTimeout: 120000,
          onData(chunk) {
            if (!parser) {
              if (fh == null) { fh = fs.openSync(outFile, 'w'); fs.writeSync(fh, '['); }
              parser = new LiteListParser((t) => { try { fs.writeSync(fh, t); } catch (e) { writeErr = e; throw e; } });
            }
            parser.feed(chunk);
          },
        });
        status = r.status;
        if (status < 200 || status >= 300) {
          if (fh != null) { fs.closeSync(fh); fh = null; }
          await fsp.rm(outFile, { force: true }).catch(() => {});
          return JSON.stringify({ status, b64: U.b64utf8('HTTP ' + status) });
        }
        if (writeErr) throw writeErr;
        if (!parser) parser = new LiteListParser(() => {});
        parser.finish();
        if (fh == null) { fh = fs.openSync(outFile, 'w'); fs.writeSync(fh, '['); }
        fs.writeSync(fh, ']');
        fs.closeSync(fh); fh = null;
        const size = fs.statSync(outFile).size;
        return JSON.stringify({ status, spill: spillToken(outFile), size, count: parser.count });
      } catch (e) {
        if (fh != null) { try { fs.closeSync(fh); } catch (x) { /* ignore */ } }
        await fsp.rm(outFile, { force: true }).catch(() => {});
        return errJson(e);
      }
    },

    uploadBegin() { uploadBuf = []; uploadSize = 0; },
    uploadAppend(b64chunk) {
      try {
        const b = U.b64decode(b64chunk);
        uploadBuf.push(b); uploadSize += b.length;
        return 'OK:' + uploadSize;
      } catch (e) { return 'ERR:' + U.errMsg(e); }
    },
    uploadCommit(url, csrf, fileName) {
      const bytes = Buffer.concat(uploadBuf);
      uploadBuf = []; uploadSize = 0;
      const { boundary, body } = multipart(U.toStr(fileName), bytes);
      return postBytes(url, U.toStr(csrf), 'multipart/form-data; boundary=' + boundary, body, 0);
    },
    postMultipart(url, csrf, fileName, fileB64) {
      let bytes;
      try { bytes = U.b64decode(fileB64); } catch (e) { return JSON.stringify({ status: -1, b64: U.b64utf8(U.errMsg(e)) }); }
      const { boundary, body } = multipart(U.toStr(fileName), bytes);
      return postBytes(url, U.toStr(csrf), 'multipart/form-data; boundary=' + boundary, body, 0);
    },
    postRaw(url, csrf, contentType, bodyB64) {
      let bytes;
      try { bytes = U.b64decode(bodyB64); } catch (e) { return JSON.stringify({ status: -1, b64: U.b64utf8(U.errMsg(e)) }); }
      return postBytes(url, U.toStr(csrf), String(contentType), bytes, 10 * 1024 * 1024);
    },
  };
  return { methods };
}

module.exports = { createStHttpBridge };
