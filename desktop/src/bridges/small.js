'use strict';
// 体量较小的桥：AndroidAI、AndroidGuard、AndroidDiagnosis、AndroidNav、AndroidPicker。
const os = require('os');
const path = require('path');
const { shell } = require('electron');
const U = require('../util');
const { httpRequest } = require('../http');

// —— AndroidAI：OpenAI 兼容接口请求。API Key 只发往用户配置的地址。 ——
function createAiBridge(ctx) {
  async function request(method, url, apiKey, body) {
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only HTTP/HTTPS endpoints are allowed');
      const headers = { Accept: 'application/json' };
      if (apiKey != null && String(apiKey).trim()) headers.Authorization = 'Bearer ' + String(apiKey).trim();
      if (body != null) headers['Content-Type'] = 'application/json; charset=utf-8';
      const parts = [];
      let total = 0;
      const r = await httpRequest({
        method, url: String(url), session: ctx.sessions.ai, cookies: false, headers,
        body: body != null ? Buffer.from(String(body), 'utf8') : null,
        connectTimeout: 20000, readTimeout: 120000,
        onData(chunk) {
          total += chunk.length;
          if (total > 8 * 1024 * 1024) throw new Error('AI response exceeds 8MB');
          parts.push(chunk);
        },
      });
      return JSON.stringify({ status: r.status, b64: U.b64(Buffer.concat(parts)) });
    } catch (e) {
      return JSON.stringify({ status: -1, b64: U.b64utf8(U.errMsg(e)) });
    }
  }
  function asyncRequest(requestId, method, url, apiKey, body) {
    const id = String(requestId == null ? '' : requestId).replace(/'/g, '');
    request(method, url, apiKey, body).then((result) => {
      const encoded = U.b64utf8(result);
      ctx.evalInPage(`window.onAIHttpResult&&window.onAIHttpResult(${JSON.stringify(id)},${JSON.stringify(encoded)})`);
    });
  }
  return {
    methods: {
      get(url, apiKey) { return request('GET', url, U.toStr(apiKey), null); },
      post(url, apiKey, body) { return request('POST', url, U.toStr(apiKey), U.toStr(body)); },
      getAsync(requestId, url, apiKey) { asyncRequest(requestId, 'GET', url, U.toStr(apiKey), null); },
      postAsync(requestId, url, apiKey, body) { asyncRequest(requestId, 'POST', url, U.toStr(apiKey), U.toStr(body)); },
    },
  };
}

// —— AndroidGuard：独立于 IndexedDB 的“曾有卡”哨兵，只记数量和时间。 ——
const GUARD = 'kaku_storage_guard';
function createGuardBridge(ctx) {
  const P = ctx.prefs;
  return {
    methods: {
      hadCards() { return !!P.get(GUARD, 'had_cards', false); },
      markCards() { P.put(GUARD, 'had_cards', true); },
      clearCards() {
        P.edit(GUARD, (o) => { o.had_cards = false; o.last_count = 0; o.max_count = 0; o.last_nonzero_at = 0; o.last_seen_at = Date.now(); });
      },
      updateCardCount(count) {
        count = Math.max(0, U.toInt(count));
        P.edit(GUARD, (o) => {
          o.last_count = count; o.last_seen_at = Date.now();
          if (count > 0) { o.had_cards = true; o.max_count = Math.max(count, Number(o.max_count || 0)); o.last_nonzero_at = Date.now(); }
        });
      },
      status() { return JSON.stringify(guardStatus(P)); },
    },
  };
}
function guardStatus(P) {
  return {
    hadCards: !!P.get(GUARD, 'had_cards', false),
    lastCount: Number(P.get(GUARD, 'last_count', 0)),
    maxCount: Number(P.get(GUARD, 'max_count', 0)),
    lastSeenAt: Number(P.get(GUARD, 'last_seen_at', 0)),
    lastNonzeroAt: Number(P.get(GUARD, 'last_nonzero_at', 0)),
  };
}

// —— AndroidDiagnosis：只读、脱敏。不读取卡片内容、文件名、目录或密钥。 ——
const DIAG = 'kaku_diagnosis';
function redact(value) {
  let s = value == null ? '' : String(value);
  s = s.replace(/bearer\s+[^\s]+/gi, 'Bearer [secret]');
  s = s.replace(/sk[-_][A-Za-z0-9._-]{6,}/gi, '[secret]');
  s = s.replace(/(content|file|kaku):\/\/[^\s]+/gi, '[local-resource]');
  s = s.replace(/https?:\/\/[^\s]+/gi, '[network-endpoint]');
  s = s.replace(/(\/storage\/|\/sdcard\/|\/data\/|\/home\/|\/Users\/|\/tmp\/|\/mnt\/)[^\s]+/g, '[local-path]');
  s = s.replace(/\b[A-Za-z]:[\\/][^\s]*/g, '[local-path]');
  s = s.replace(/\\\\[^\s\\]+\\[^\s]*/g, '[local-path]');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  return s.replace(/[\n\r]/g, ' ').trim();
}
function createDiagnosisBridge(ctx) {
  const P = ctx.prefs;
  function record(level, module, message) {
    try {
      let safe = redact(message);
      if (safe.length > 600) safe = safe.slice(0, 600);
      let mod = module == null ? 'app' : String(module).replace(/[^A-Za-z0-9_\-一-龥]/g, '_');
      if (mod.length > 40) mod = mod.slice(0, 40);
      let old = P.get(DIAG, 'events', []);
      if (!Array.isArray(old)) old = [];
      const out = old.slice(Math.max(0, old.length - 199));
      out.push({ at: Date.now(), level: level === 'error' ? 'error' : 'note', module: mod, message: safe });
      P.put(DIAG, 'events', out);
    } catch (e) { /* ignore */ }
  }
  ctx.recordDiagnosis = record;
  const mb = (b) => Math.max(0, Math.floor(Number(b) / (1024 * 1024)));
  return {
    methods: {
      record(level, module, message) { record(U.toStr(level), U.toStr(module), U.toStr(message)); },
      clearLogs() { P.remove(DIAG, 'events'); },
      async startupCheckpoint(cardCount) {
        try {
          const current = process.versions.chrome || 'unknown';
          const previous = String(P.get(DIAG, 'last_webview_version', ''));
          const change = previous.length === 0 ? 'first_record' : (previous === current ? 'same' : 'changed');
          const free = mb(await U.freeBytes(ctx.paths.userData));
          record('note', 'startup_checkpoint', 'stage=app_start; outcome=ok; cards=' + Math.max(0, U.toInt(cardCount)) + '; webview=' + change + '; privateFreeMB=' + free);
          if (change === 'changed') record('note', 'webview_runtime', 'stage=version; outcome=changed');
          P.edit(DIAG, (o) => { o.last_webview_version = current; o.last_checkpoint_at = Date.now(); });
        } catch (e) { /* ignore */ }
      },
      async environmentReport() {
        const out = {};
        try {
          out.source = process.platform === 'win32' ? 'windows-desktop' : 'desktop-' + process.platform;
          out.os = os.type();
          out.osRelease = os.release();
          out.arch = process.arch;
          out.appVersion = ctx.version.name;
          out.appVersionCode = ctx.version.code;
          out.webViewPackage = 'Electron ' + process.versions.electron;
          out.webViewVersion = process.versions.chrome || '无法读取';
          out.storage = {
            privateFreeMB: mb(await U.freeBytes(ctx.paths.userData)),
            privateTotalMB: mb(await U.totalBytes(ctx.paths.userData)),
          };
          const dl = path.dirname(ctx.paths.downloads);
          const sf = await U.freeBytes(dl);
          if (sf >= 0) { out.storage.sharedFreeMB = mb(sf); out.storage.sharedTotalMB = mb(await U.totalBytes(dl)); }
          else out.storage.sharedAvailable = false;
          const free = os.freemem(), total = os.totalmem();
          out.memory = { availableMB: mb(free), totalMB: mb(total), lowMemory: free < 512 * 1024 * 1024, lowMemoryThresholdMB: 512 };
          out.pickers = { systemFile: true, otherFileManager: false, folderAuthorization: true };
          out.safety = await ctx.safetyDiagnosis();
          out.storageGuard = guardStatus(P);
          out.diagnosticCheckpoint = { hasWebViewBaseline: P.has(DIAG, 'last_webview_version'), lastCheckpointAt: Number(P.get(DIAG, 'last_checkpoint_at', 0)) };
          let events = P.get(DIAG, 'events', []);
          if (!Array.isArray(events)) events = [];
          out.recentEvents = events.slice(Math.max(0, events.length - 200));
          out.privacy = 'No card text, image, chat, secret, account, filename or directory URI collected';
        } catch (e) { out.reportError = redact(e && e.name ? e.name : 'Error'); }
        return JSON.stringify(out);
      },
    },
  };
}

// —— AndroidNav：外部链接交给系统浏览器；退出 = 关闭窗口。 ——
function createNavBridge(ctx) {
  return {
    methods: {
      openUrl(url) {
        let ok = false;
        try {
          const u = new URL(String(url));
          if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
            ok = true;
            shell.openExternal(u.href).catch(() => ctx.toast('无法打开链接'));
          }
        } catch (e) { ok = false; }
        if (!ok) ctx.toast('无法打开链接');
      },
      exitApp() { setImmediate(() => ctx.closeWindow()); },
    },
  };
}

// —— AndroidPicker：Windows 只有一种系统文件对话框，多选由 <input multiple> 决定。 ——
function createPickerBridge() {
  let multiple = false, mode = 'system';
  return {
    methods: {
      setMultiple(m) { multiple = U.toBool(m); },
      setMode(m) { mode = m === 'other' ? 'other' : 'system'; },
    },
    state: () => ({ multiple, mode }),
  };
}

module.exports = { createAiBridge, createGuardBridge, createDiagnosisBridge, createNavBridge, createPickerBridge, redact };
