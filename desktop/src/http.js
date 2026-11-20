'use strict';
// 基于 Electron net（Chromium 网络栈）的请求封装：会使用 Windows 系统代理设置，
// 对应 Java HttpURLConnection 的连接/读取超时、重定向开关和响应大小限制。
const { net } = require('electron');

class HttpError extends Error {}

/**
 * opts: { method, url, session, headers, body(Buffer), cookies(bool), followRedirects(bool),
 *         httpsOnlyRedirects(bool), maxRedirects, connectTimeout, readTimeout, onData(chunk) }
 * 返回 { status, headers }；响应体通过 onData 逐块交给调用方（可抛错中止）。
 * followRedirects=false 时与 Java setInstanceFollowRedirects(false) 一致：直接返回 3xx 状态。
 */
function httpRequest(opts) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    let req;
    let redirects = 0;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (err) { try { req && req.abort(); } catch (e) { /* ignore */ } reject(err); }
      else resolve(val);
    };
    const arm = (ms, label) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(new HttpError(label)), ms);
    };
    try {
      const u = new URL(opts.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError('Only HTTP/HTTPS endpoints are allowed');
      req = net.request({
        method: opts.method || 'GET',
        url: opts.url,
        session: opts.session,
        credentials: opts.cookies ? 'include' : 'omit',
        useSessionCookies: !!opts.cookies,
        redirect: 'manual',
        cache: 'no-store',
      });
    } catch (e) { finish(e); return; }
    for (const [k, v] of Object.entries(opts.headers || {})) {
      if (v != null && v !== '') req.setHeader(k, String(v));
    }
    req.on('login', (authInfo, callback) => { callback(); }); // 不弹认证框，直接把 401 交给调用方
    req.on('redirect', (statusCode, method, redirectUrl, responseHeaders) => {
      if (opts.followRedirects === false) {
        finish(null, { status: statusCode, headers: responseHeaders || {}, redirected: redirectUrl });
        try { req.abort(); } catch (e) { /* ignore */ }
        return;
      }
      redirects++;
      if (redirects > (opts.maxRedirects || 20)) { finish(new HttpError('重定向次数过多')); return; }
      if (opts.httpsOnlyRedirects && !/^https:/i.test(redirectUrl)) { finish(new HttpError('更新地址必须使用 HTTPS')); return; }
      try { req.followRedirect(); } catch (e) { finish(e); }
    });
    req.on('response', (res) => {
      if (done) return;
      const status = res.statusCode;
      arm(opts.readTimeout || 30000, 'Read timed out');
      res.on('data', (chunk) => {
        if (done) return;
        arm(opts.readTimeout || 30000, 'Read timed out');
        try { if (opts.onData) opts.onData(chunk); } catch (e) { finish(e); }
      });
      res.on('end', () => finish(null, { status, headers: res.headers || {} }));
      res.on('error', (e) => finish(e));
      res.on('aborted', () => finish(new HttpError('连接中断')));
    });
    req.on('error', (e) => finish(e));
    req.on('abort', () => finish(new HttpError('请求已取消')));
    arm((opts.connectTimeout || 20000) + (opts.readTimeout || 30000), 'connect timed out');
    try {
      if (opts.body && opts.body.length) req.write(opts.body);
      req.end();
    } catch (e) { finish(e); }
  });
}

/** 读完整响应到内存（带上限）。 */
async function httpBuffer(opts, maxBytes, tooLarge) {
  const parts = [];
  let total = 0;
  const r = await httpRequest({
    ...opts,
    onData(chunk) {
      total += chunk.length;
      if (maxBytes && total > maxBytes) throw (tooLarge || new HttpError('响应过大'));
      parts.push(chunk);
    },
  });
  return { status: r.status, headers: r.headers, body: Buffer.concat(parts) };
}

module.exports = { httpRequest, httpBuffer, HttpError };
