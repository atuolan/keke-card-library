'use strict';
// AndroidFolder —— 对应 MainActivity.FolderBridge。
// Android 的 SAF 目录授权 → Windows 资料夹对话框；返回给页面的 uri 是 file:/// URL，
// 每次调用都会检查路径是否在用户选过的目录里（扫描目录、酒馆存档点、实时备份目录）或 userData。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { nativeImage } = require('electron');
const U = require('../util');
const PJ = require('../persona-json');

const MB = 1024 * 1024;
const JAVA_BAD = /[/:*?"<>|]/g; // Java "[\\/:*?\"<>|]"（不含反斜杠，反斜杠由 safeFileName 处理）
const PERSONA_NAME = /^kaku_persona_[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/;

function isSafetyMetaName(name) {
  const low = name == null ? '' : String(name).toLowerCase();
  return (low.startsWith('kaku_meta_') && low.includes('.json')) || (low.startsWith('kaku_') && (low.includes('.kaku-meta') || low.includes('.kakumeta')));
}
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function createFolderBridge(ctx) {
  const P = ctx.prefs;
  const scanCache = () => path.join(ctx.paths.cache, 'folder_scan');
  let tavernOut = null;   // { fh, tmp, final }
  let safetyOut = null;   // { fh }
  let safetyRead = null;  // { fh, pos }
  const safetyBatch = new Map(); // 小写文件名 → 实际文件名
  let safetyBatchActive = false;
  let personaCommitRunning = false;

  // ———————————————— 通用 ————————————————
  async function readSmall(p, limit) {
    const st = await fsp.stat(p);
    if (st.size > limit) return null;
    return fsp.readFile(p);
  }
  async function isDir(p) { try { return (await fsp.stat(p)).isDirectory(); } catch (e) { return false; } }
  const javaName = (name, fallback) => U.safeFileName(name == null ? fallback : String(name).replace(JAVA_BAD, '_'), fallback);

  // ———————————————— 酒馆存档点 ————————————————
  function tavernPointPath(pointId) {
    const id = (pointId == null || String(pointId).length === 0) ? 'legacy' : String(pointId);
    return String(P.get('tavern_folders', id, '') || '');
  }
  async function childDir(parent, wanted) { return U.findChild(parent, wanted, true); }
  async function findCharactersDir(root) {
    const n = path.basename(root);
    if (n.toLowerCase() === 'characters') return root;
    if (n.toLowerCase() === 'default-user') { const x = await childDir(root, 'characters'); if (x) return x; }
    const direct = await childDir(root, 'characters'); if (direct) return direct;
    let def = await childDir(root, 'default-user');
    if (def) { const x = await childDir(def, 'characters'); if (x) return x; }
    const data = await childDir(root, 'data');
    if (data) { def = await childDir(data, 'default-user'); if (def) { const x = await childDir(def, 'characters'); if (x) return x; } }
    throw new Error('未找到 default-user/characters，请直接选择 characters 或 default-user 文件夹');
  }
  async function tavernRoot(pointId) {
    const u = tavernPointPath(pointId);
    if (!u) throw new Error('尚未选择酒馆文件夹');
    if (!(await isDir(u))) throw new Error('目录不存在或无法访问，请重新选择');
    return u;
  }
  async function personaRoot(pointId) {
    const u = tavernPointPath(pointId);
    if (!u) throw new Error('请先选择酒馆账号目录');
    if (!(await U.findChild(u, 'settings.json', false))) throw new Error('请选择直接包含 settings.json 与 User Avatars 的账号目录');
    return u;
  }
  async function modeDir(pointId, mode) {
    if (mode === 'persona') {
      const d = await childDir(await personaRoot(pointId), 'User Avatars');
      if (!d) throw new Error('未找到 User Avatars 目录');
      return d;
    }
    const root = await tavernRoot(pointId);
    return mode === 'cards' ? findCharactersDir(root) : root;
  }
  function allTavernRoots() { return Object.values(P.all('tavern_folders')).filter((x) => typeof x === 'string' && x); }
  async function authorizedTavernFile(uri) {
    const p = U.uriToPath(uri);
    for (const root of allTavernRoots()) if (await U.isWithin(root, p)) return p;
    throw new Error('该文件不在已授权的酒馆目录中');
  }
  async function closeTavernOut(deleteTmp) {
    const t = tavernOut; tavernOut = null;
    if (!t) return;
    try { await t.fh.close(); } catch (e) { /* ignore */ }
    if (deleteTmp) await fsp.rm(t.tmp, { force: true }).catch(() => {});
  }

  // ———————————————— User 设定 ————————————————
  function personaStage(stage) {
    ctx.evalInPage(`window.onPersonaNativeStage&&window.onPersonaNativeStage(${JSON.stringify(String(stage))})`);
  }
  async function readSettingsBytes(file) {
    const st = await fsp.stat(file);
    if (st.size > 32 * MB) throw new Error('设置文件超过32MB，本测试版停止读取');
    return fsp.readFile(file);
  }
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  async function readPersonaSettings(id) {
    try {
      const file = await U.findChild(await personaRoot(id), 'settings.json', false);
      const bytes = await readSettingsBytes(file);
      const hash = sha(bytes);
      const root = PJ.extractPersona(bytes.toString('utf8'));
      if (hash !== (await U.sha256File(file))) throw new Error('设置读取期间发生变化，请重新扫描');
      return JSON.stringify({ text: JSON.stringify(root), token: hash });
    } catch (e) { return JSON.stringify({ error: U.errMsg(e) }); }
  }

  async function commitPersonaSettings(id, expected, entries) {
    let temp = null;
    try {
      personaStage('正在读取并校验酒馆设置…');
      const root = await personaRoot(id);
      const settings = await U.findChild(root, 'settings.json', false);
      const original = await readSettingsBytes(settings);
      if (sha(original) !== expected) throw new Error('设置已变化，请停止酒馆后重新扫描');
      const selected = JSON.parse(await readPersonaSettings(id));
      if (selected.error) throw new Error(selected.error);
      const power = JSON.parse(selected.text).power_user;
      const names = power.personas, descs = power.persona_descriptions;
      if (!PJ.isObj(names) || !PJ.isObj(descs)) throw new Error('缺少User集合，停止写回');
      const rows = JSON.parse(String(entries));
      if (!Array.isArray(rows)) throw new Error('JSONArray text must start with [');
      for (const row of rows) {
        if (!PJ.isObj(row)) throw new Error('JSONArray[i] is not a JSONObject');
        const key = String(row.key);
        if (!PERSONA_NAME.test(key)) throw new Error('新头像文件名无效');
        const d = row.descriptor;
        if (!PJ.isObj(d)) throw new Error('JSONObject["descriptor"] not found');
        if (row.description == null || row.name == null) throw new Error('JSONObject["name"] not found');
        d.description = String(row.description);
        names[key] = String(row.name);
        descs[key] = d;
      }
      const tag = Date.now() + '-' + crypto.randomUUID().slice(0, 8);
      temp = path.join(root, 'settings.persona-stage-' + tag + '.json');
      personaStage('正在合并名称、正文和配置…');
      const patched = PJ.patchPersona(original.toString('utf8'), { personas: names, persona_descriptions: descs });
      await fsp.writeFile(temp, patched, { encoding: 'utf8', flag: 'wx' });
      const stagedHash = await U.sha256File(temp);
      personaStage('正在备份并校验酒馆设置，可能需要较长时间…');
      const backupName = 'settings.persona-backup-' + tag + '.json';
      const copy = path.join(root, backupName);
      await fsp.copyFile(settings, copy, fs.constants.COPYFILE_EXCL);
      if (expected !== (await U.sha256File(copy)) || expected !== (await U.sha256File(settings))) throw new Error('设置变化或备份校验失败，停止写回');
      personaStage('正在写回并核验结果，请勿关闭…');
      try {
        await fsp.copyFile(temp, settings);
        if (stagedHash !== (await U.sha256File(settings))) throw new Error('设置写入校验失败');
      } catch (error) {
        await fsp.copyFile(copy, settings);
        if (expected !== (await U.sha256File(settings))) throw new Error('恢复校验失败，请使用 ' + backupName);
        throw new Error('写回失败，已恢复设置：' + U.errMsg(error));
      }
      return JSON.stringify({ ok: true, backup: backupName });
    } catch (e) {
      return JSON.stringify({ error: U.errMsg(e) });
    } finally {
      if (temp) await fsp.rm(temp, { force: true }).catch(() => {});
    }
  }

  // ———————————————— 实时备份（安全库） ————————————————
  const safetyDir = () => String(P.get('safety_library', 'path', '') || '');
  async function safetyLookup(dir, name) {
    if (!U.isPlainName(name)) return null;
    if (safetyBatchActive) {
      const n = safetyBatch.get(String(name).toLowerCase());
      return n ? path.join(dir, n) : null;
    }
    return U.findChild(dir, name, false);
  }
  async function safetyFiles(dir) { return (await U.listDir(dir)).filter((e) => e.isFile); }
  async function closeSafetyOut() {
    const s = safetyOut; safetyOut = null;
    if (s) { try { await s.fh.close(); } catch (e) { /* ignore */ } }
  }
  async function closeSafetyRead() {
    const r = safetyRead; safetyRead = null;
    if (r) { try { await r.fh.close(); } catch (e) { /* ignore */ } }
  }
  async function authorizedSafetyFile(uri) {
    const dir = safetyDir();
    if (!dir) throw new Error('尚未选择实时备份目录');
    const p = U.uriToPath(uri);
    if (!(await U.isDirectChild(dir, p))) throw new Error('该文件不在实时备份目录中');
    return p;
  }
  async function safetyOriginalHash(dir, id) {
    const prefix = ('kaku_' + id + '__').toLowerCase();
    for (const e of await safetyFiles(dir)) {
      if (!e.name.toLowerCase().startsWith(prefix)) continue;
      try { return await U.sha256File(e.full); } catch (x) { return ''; }
    }
    return '';
  }
  async function deleteMatching(dir, match) {
    let deleted = 0;
    for (const e of await safetyFiles(dir)) {
      if (!match(e.name)) continue;
      try { await fsp.unlink(e.full); deleted++; } catch (x) { /* ignore */ }
    }
    return deleted;
  }
  ctx.safetyDiagnosis = async () => {
    const dir = safetyDir();
    const out = { configured: !!dir, permissionPersisted: false, readable: false, directoryFileCount: 0 };
    if (!dir) return out;
    try {
      out.permissionPersisted = await isDir(dir);
      const files = await safetyFiles(dir);
      out.readable = true;
      out.directoryFileCount = files.length;
    } catch (e) { out.readable = false; out.readError = e && e.code ? String(e.code) : 'Error'; }
    return out;
  };

  // ———————————————— 文件夹扫描 ————————————————
  async function scanDocPage(dir, prefix, cache, st) {
    if (st.hasMore) return;
    const ents = (await U.listDir(dir)).sort(byName);
    for (const e of ents) {
      if (e.isDir) {
        await scanDocPage(e.full, prefix + e.name + '/', cache, st);
        if (st.hasMore) return;
        continue;
      }
      const low = e.name.toLowerCase();
      if (isSafetyMetaName(e.name)) continue;
      if (!low.endsWith('.png') && !low.endsWith('.json')) { st.unsupported++; st.skip(prefix + e.name); continue; }
      const pos = st.eligible++;
      if (pos < st.offset) continue;
      if (st.copied >= st.limit) { st.hasMore = true; st.stopReason = 'limit'; return; }
      let size = 0;
      try { size = (await fsp.stat(e.full)).size; } catch (x) { size = 0; }
      if (size > 24 * MB) { st.oversized++; st.skip(prefix + e.name); st.next = pos + 1; continue; }
      const dst = path.join(cache, 'f' + st.copied + (low.endsWith('.png') ? '.png' : '.json'));
      let got = 0;
      try { await fsp.copyFile(e.full, dst); got = (await fsp.stat(dst)).size; } catch (x) {
        await fsp.rm(dst, { force: true }).catch(() => {});
        st.failed++; st.skip(prefix + e.name); st.next = pos + 1; continue;
      }
      if (got > 24 * MB) { await fsp.rm(dst, { force: true }).catch(() => {}); st.oversized++; st.skip(prefix + e.name); st.next = pos + 1; continue; }
      st.totalBytes += got; st.next = pos + 1;
      st.files.push({ name: prefix + e.name, path: dst, size: got });
      st.copied++;
    }
  }
  async function resetScanCache() { const d = scanCache(); await U.rmrf(d); await fsp.mkdir(d, { recursive: true }); return d; }

  function chooseInto(title, onPicked) {
    ctx.chooseDirectory(title).then((p) => { if (p) onPicked(p); }).catch((e) => ctx.toast('无法打开文件夹选择：' + U.errMsg(e)));
  }

  const methods = {
    // —— 图标 ——
    getLauncherIcon() { return U.toInt(P.get('appearance', 'launcherIcon', 2)) || 2; },
    setLauncherIcon(selected) {
      selected = U.toInt(selected);
      if (selected < 1 || selected > 3) return 'error:invalid';
      try {
        const img = nativeImage.createFromPath(path.join(ctx.paths.assets, 'icons', 'icon_' + selected + '.png'));
        if (img.isEmpty()) throw new Error('图标文件缺失');
        ctx.setWindowIcon(img);
        P.put('appearance', 'launcherIcon', selected);
        return 'ok';
      } catch (e) { return 'error:' + U.errMsg(e); }
    },

    // —— 酒馆存档点 ——
    chooseTavernFolder(pointId) {
      let id = (pointId == null || String(pointId).length === 0) ? 'legacy' : String(pointId).replace(/[^A-Za-z0-9_-]/g, '');
      if (!id) id = 'legacy';
      chooseInto('选择酒馆目录', (p) => {
        P.put('tavern_folders', id, p);
        ctx.evalInPage(`typeof onTavernFolderChosen==='function'&&onTavernFolderChosen(${JSON.stringify(id)})`);
      });
    },
    async getTavernFolder(pointId, kind) {
      const u = tavernPointPath(pointId);
      if (!u) return '{}';
      try {
        if (!(await isDir(u))) throw new Error('目录不存在或无法访问，请重新选择');
        const target = kind === 'cards' ? await findCharactersDir(u) : u;
        return JSON.stringify({ uri: U.fileUri(u), name: path.basename(u), target: path.basename(target), ready: target != null });
      } catch (e) { return JSON.stringify({ uri: U.fileUri(u), error: U.errMsg(e) }); }
    },
    clearTavernFolder(pointId) {
      const id = (pointId == null || String(pointId).length === 0) ? 'legacy' : String(pointId);
      P.remove('tavern_folders', id);
    },
    async scanTavernFolder(pointId, mode) {
      if (!tavernPointPath(pointId)) return '{"error":"尚未选择酒馆文件夹","files":[]}';
      try {
        const role = mode === 'cards';
        const dir = await modeDir(pointId, mode === 'persona' ? 'persona' : (role ? 'cards' : 'root'));
        const files = [];
        for (const e of (await U.listDir(dir)).sort(byName)) {
          if (files.length >= 5000) break;
          if (!e.isFile) continue;
          const low = e.name.toLowerCase();
          const ok = low.endsWith('.png') || low.endsWith('.json') || (!role && (low.endsWith('.txt') || low.endsWith('.docx') || low.endsWith('.webp') || low.endsWith('.jpg') || low.endsWith('.jpeg')));
          if (!ok) continue;
          let size = 0;
          try { size = (await fsp.stat(e.full)).size; } catch (x) { size = 0; }
          files.push({ name: e.name, uri: U.fileUri(e.full), size });
        }
        return JSON.stringify({ files, count: files.length, target: path.basename(dir) });
      } catch (e) { return JSON.stringify({ error: U.errMsg(e), files: [] }); }
    },
    async readTavernChunk(uri, offset, len) {
      try {
        const p = await authorizedTavernFile(String(uri));
        const n = Math.min(U.toInt(len), 512 * 1024);
        if (n <= 0) return '';
        const b = await U.readAt(p, Math.max(0, U.toInt(offset)), n);
        return b.length ? U.b64(b) : '';
      } catch (e) { return ''; }
    },
    async beginTavernWrite(pointId, mode, name, overwrite) {
      try {
        await closeTavernOut(true);
        name = javaName(name, 'file.bin');
        const dir = await modeDir(pointId, mode === 'persona' ? 'persona' : (mode === 'cards' ? 'cards' : 'root'));
        const old = await U.findChild(dir, name, null);
        if (old && !U.toBool(overwrite)) return 'exists';
        const final = old || path.join(dir, name);
        if (path.dirname(final) !== dir) throw new Error('无效的文件名');
        if (old && (await isDir(old))) throw new Error('同名目录已存在');
        const tmp = path.join(dir, '.' + path.basename(final) + '.kaku-tmp-' + crypto.randomBytes(4).toString('hex'));
        tavernOut = { fh: await fsp.open(tmp, 'wx'), tmp, final };
        return 'ok';
      } catch (e) { return 'error:' + U.errMsg(e); }
    },
    async appendTavernChunk(b64) {
      try {
        if (!tavernOut) return false;
        await tavernOut.fh.write(U.b64decode(b64));
        return true;
      } catch (e) { return false; }
    },
    async endTavernWrite() {
      const t = tavernOut;
      if (!t) return false;
      tavernOut = null;
      try {
        await t.fh.sync().catch(() => {});
        await t.fh.close();
        await fsp.rename(t.tmp, t.final);
        return true;
      } catch (e) {
        try { await t.fh.close(); } catch (x) { /* ignore */ }
        await fsp.rm(t.tmp, { force: true }).catch(() => {});
        return false;
      }
    },

    // —— User 设定 ——
    readPersonaSettings(id) { return readPersonaSettings(U.toStr(id)); },
    commitPersonaSettings(id, expected, entries) { return commitPersonaSettings(U.toStr(id), U.toStr(expected), U.toStr(entries)); },
    commitPersonaSettingsAsync(id, expected, entries) {
      if (personaCommitRunning) return;
      personaCommitRunning = true;
      ctx.busy.add('persona');
      commitPersonaSettings(U.toStr(id), U.toStr(expected), U.toStr(entries)).then((result) => {
        personaCommitRunning = false;
        ctx.busy.delete('persona');
        ctx.evalInPage(`window.onPersonaNativeDone&&window.onPersonaNativeDone(${JSON.stringify(result)})`);
      });
    },
    async rollbackPersonaAvatar(id, name) {
      try {
        name = String(name);
        if (!PERSONA_NAME.test(name)) throw new Error('文件名无效');
        const dir = await childDir(await personaRoot(U.toStr(id)), 'User Avatars');
        if (!dir) throw new Error('未找到 User Avatars 目录');
        const file = await U.findChild(dir, name, false);
        if (!file) return 'ok';
        try { await fsp.unlink(file); return 'ok'; } catch (e) { return 'error:头像回退失败'; }
      } catch (e) { return 'error:' + U.errMsg(e); }
    },

    // —— 实时备份 ——
    chooseSafetyFolder() {
      chooseInto('选择实时备份目录', (p) => {
        P.put('safety_library', 'path', p);
        ctx.evalInPage("typeof onSafetyFolderChosen==='function'&&onSafetyFolderChosen()");
      });
    },
    async disableSafetyFolder() { await closeSafetyOut(); P.remove('safety_library', 'path'); },
    safetyInfo() {
      const d = safetyDir();
      return JSON.stringify({ ready: d.length > 0, uri: d ? U.fileUri(d) : '', name: d });
    },
    safetyFolderUri() { const d = safetyDir(); return d ? U.fileUri(d) : ''; },
    async beginSafetyBatch() {
      try {
        safetyBatch.clear();
        const dir = safetyDir();
        if (!dir) return '{}';
        for (const e of await U.listDir(dir)) safetyBatch.set(e.name.toLowerCase(), e.name);
        safetyBatchActive = true;
        return '{}';
      } catch (e) { safetyBatch.clear(); safetyBatchActive = false; return ''; }
    },
    endSafetyBatch() { safetyBatchActive = false; safetyBatch.clear(); },
    hasSafetyPair(rawName, metaName) {
      return safetyBatchActive && safetyBatch.has(String(rawName).toLowerCase()) && safetyBatch.has(String(metaName).toLowerCase());
    },
    async commitSafetyRevision(rawTemp, rawName, metaTemp, metaName) {
      try {
        const dir = safetyDir();
        if (!dir) throw new Error('尚未选择实时备份目录');
        rawTemp = String(rawTemp); rawName = String(rawName); metaTemp = String(metaTemp); metaName = String(metaName);
        for (const n of [rawTemp, rawName, metaTemp, metaName]) if (!U.isPlainName(n)) return 'error:无效的文件名';
        const raw = await safetyLookup(dir, rawTemp), meta = await safetyLookup(dir, metaTemp);
        if (!raw || !meta || !(await U.exists(raw)) || !(await U.exists(meta))) return 'error:临时副本缺失，保留旧备份';
        const suffix = '.previous_' + Date.now();
        let oldRaw = await safetyLookup(dir, rawName), oldMeta = await safetyLookup(dir, metaName);
        if (oldRaw && !(await U.exists(oldRaw))) oldRaw = null;
        if (oldMeta && !(await U.exists(oldMeta))) oldMeta = null;
        // 保留旧的完整文件，绝不原地截断。
        if (oldRaw) { const to = path.join(dir, rawName + suffix); try { await fsp.rename(oldRaw, to); oldRaw = to; } catch (e) { return 'error:无法保留旧原件'; } }
        if (oldMeta) { const to = path.join(dir, metaName + suffix); try { await fsp.rename(oldMeta, to); oldMeta = to; } catch (e) { return 'error:无法保留旧元数据'; } }
        try { await fsp.rename(raw, path.join(dir, rawName)); } catch (e) { return 'error:原件提交失败，旧副本仍保留'; }
        try { await fsp.rename(meta, path.join(dir, metaName)); } catch (e) { return 'error:元数据提交失败，旧副本仍保留'; }
        if (oldRaw) await fsp.unlink(oldRaw).catch(() => {});
        if (oldMeta) await fsp.unlink(oldMeta).catch(() => {});
        if (safetyBatchActive) {
          safetyBatch.delete(rawTemp.toLowerCase()); safetyBatch.delete(metaTemp.toLowerCase());
          safetyBatch.set(rawName.toLowerCase(), rawName); safetyBatch.set(metaName.toLowerCase(), metaName);
        }
        return 'ok';
      } catch (e) { return 'error:' + U.errMsg(e); }
    },
    beginSafetyWrite(name) { return methods.beginSafetyWriteMode(name, false); },
    async beginSafetyWriteMode(name, overwrite) {
      try {
        await closeSafetyOut();
        const dir = safetyDir();
        if (!dir) return 'not_configured';
        name = javaName(name, 'card.bin');
        const low = name.toLowerCase();
        const old = await safetyLookup(dir, name);
        if (old && !U.toBool(overwrite)) return 'exists';
        const target = old || path.join(dir, name);
        if (path.dirname(target) !== dir) throw new Error('无效的文件名');
        if (safetyBatchActive) safetyBatch.set(low, path.basename(target));
        safetyOut = { fh: await fsp.open(target, 'w') };
        return 'ok';
      } catch (e) { return 'error:' + U.errMsg(e); }
    },
    async appendSafetyChunk(b64) {
      try {
        if (!safetyOut) return false;
        await safetyOut.fh.write(U.b64decode(b64));
        return true;
      } catch (e) { return false; }
    },
    async endSafetyWrite() {
      const s = safetyOut;
      if (!s) return false;
      safetyOut = null;
      try { await s.fh.sync().catch(() => {}); await s.fh.close(); return true; } catch (e) { try { await s.fh.close(); } catch (x) { /* ignore */ } return false; }
    },
    async deleteSafetyCard(id) {
      if (id == null || String(id).length === 0) return 0;
      const dir = safetyDir();
      if (!dir) return 0;
      const prefix = 'kaku_' + id;
      try {
        return await deleteMatching(dir, (name) => name.startsWith(prefix + '__') || name === prefix + '.kaku-meta' || name.startsWith('kaku_meta_' + id + '.json'));
      } catch (e) { return 0; }
    },
    async deleteSafetyCards(idsJson) {
      const dir = safetyDir();
      if (!dir) return 0;
      try {
        const a = JSON.parse(idsJson == null ? '[]' : String(idsJson));
        if (!Array.isArray(a)) return 0;
        const ids = new Set(a.map((x) => (x == null ? '' : String(x)).toLowerCase()).filter((x) => x.length > 0));
        if (!ids.size) return 0;
        return await deleteMatching(dir, (name) => {
          const low = name.toLowerCase();
          for (const id of ids) {
            if (low.startsWith('kaku_' + id + '__') || low.startsWith('kaku_meta_' + id) || low.startsWith('kaku_' + id + '.kaku-meta') || low.startsWith('kaku_' + id + '.kakumeta')) return true;
          }
          return false;
        });
      } catch (e) { return 0; }
    },
    async deleteSafetyMeta(id) {
      if (id == null || String(id).length === 0) return 0;
      const dir = safetyDir();
      if (!dir) return 0;
      const target = String(id).toLowerCase();
      const match = (low) => low.startsWith('kaku_meta_' + target) || (low.startsWith('kaku_' + target) && (low.includes('.kaku-meta') || low.includes('.kakumeta')));
      if (safetyBatchActive) {
        let deleted = 0;
        for (const [low, actual] of [...safetyBatch.entries()]) {
          if (!match(low)) continue;
          safetyBatch.delete(low);
          try { await fsp.unlink(path.join(dir, actual)); deleted++; } catch (e) { /* ignore */ }
        }
        return deleted;
      }
      try { return await deleteMatching(dir, (name) => match(name.toLowerCase())); } catch (e) { return 0; }
    },
    async cleanupSafetyMetadata() {
      const dir = safetyDir();
      if (!dir) return 0;
      try { return await deleteMatching(dir, isSafetyMetaName); } catch (e) { return 0; }
    },
    async findSafetyIdByHash(hash, excludeId) {
      if (hash == null || String(hash).length === 0) return '';
      hash = String(hash);
      const dir = safetyDir();
      if (!dir) return '';
      try {
        for (const e of (await safetyFiles(dir)).sort(byName)) {
          const low = e.name.toLowerCase();
          if (!low.startsWith('kaku_meta_') || !low.includes('.json')) continue;
          try {
            const buf = await fsp.readFile(e.full);
            const o = JSON.parse(buf.subarray(0, 1024 * 1024 + 4096).toString('utf8'));
            const id = o && o.id != null ? String(o.id) : '';
            const oldHash = o && o.importHash != null ? String(o.importHash) : '';
            if (id !== excludeId && (hash === oldHash || (oldHash.length === 0 && hash === (await safetyOriginalHash(dir, id))))) return id;
          } catch (x) { /* 跳过损坏的元数据 */ }
        }
      } catch (e) { /* ignore */ }
      return '';
    },
    async readSafetyMeta(id) {
      try {
        const dir = safetyDir();
        if (!dir) return '';
        id = String(id);
        let x = await U.findChild(dir, 'kaku_meta_' + id + '.json', false);
        if (!x) x = await U.findChild(dir, 'kaku_' + id + '.kaku-meta', false);
        if (!x) x = await U.findChild(dir, 'kaku_' + id + '.kaku-meta.json', false);
        if (!x) return '';
        const b = await readSmall(x, 1024 * 1024);
        return b == null ? '' : U.b64(b);
      } catch (e) { return ''; }
    },
    async indexSafetyRestore() {
      const files = [];
      try {
        const dir = safetyDir();
        if (!dir) throw new Error('尚未选择实时备份目录');
        const originals = new Map();
        const metas = new Map();
        for (const e of (await safetyFiles(dir)).sort(byName)) {
          const name = e.name, low = name.toLowerCase();
          if (low.includes('.pending_') || low.includes('.previous_')) continue;
          if (low.startsWith('kaku_meta_') && low.endsWith('.json')) {
            const end = low.indexOf('.json', 10);
            const id = end > 10 ? name.substring(10, end) : '';
            if (!id) continue;
            try {
              const b = await readSmall(e.full, 1024 * 1024 + 8192);
              if (b) metas.set(id, JSON.parse(b.toString('utf8')));
            } catch (x) { /* ignore */ }
            continue;
          }
          if (!low.startsWith('kaku_') || !low.includes('__') || (!low.endsWith('.png') && !low.endsWith('.json'))) continue;
          const sep = name.indexOf('__', 5);
          if (sep <= 5) continue;
          const id = name.substring(5, sep), restoreName = name.substring(sep + 2);
          let size = 0;
          try { size = (await fsp.stat(e.full)).size; } catch (x) { size = 0; }
          originals.set(id, { id, name: restoreName, uri: U.fileUri(e.full), size });
        }
        for (const [id, row] of originals) {
          const meta = metas.get(id);
          if (meta != null) { row.meta = meta; row.section = PJ.isObj(meta) && meta.section != null ? String(meta.section) : ''; }
          files.push(row);
        }
        return JSON.stringify({ files, count: files.length });
      } catch (e) { return JSON.stringify({ error: U.errMsg(e), files }); }
    },
    async beginSafetyRead(uri) {
      try {
        await closeSafetyRead();
        const p = await authorizedSafetyFile(String(uri));
        safetyRead = { fh: await fsp.open(p, 'r'), pos: 0 };
        return true;
      } catch (e) { await closeSafetyRead(); return false; }
    },
    async nextSafetyReadChunk(len) {
      try {
        if (!safetyRead) return '';
        const n = Math.max(1, Math.min(U.toInt(len), MB));
        const buf = Buffer.alloc(n);
        const { bytesRead } = await safetyRead.fh.read(buf, 0, n, safetyRead.pos);
        if (!bytesRead) return '';
        safetyRead.pos += bytesRead;
        return U.b64(buf.subarray(0, bytesRead));
      } catch (e) { return ''; }
    },
    async endSafetyRead() { await closeSafetyRead(); },
    async readSafetyChunk(uri, offset, len) {
      try {
        const p = await authorizedSafetyFile(String(uri));
        const b = await U.readAt(p, Math.max(0, U.toInt(offset)), Math.max(1, Math.min(U.toInt(len), MB)));
        return b.length ? U.b64(b) : '';
      } catch (e) { return ''; }
    },
    async scanSafetyFolder() {
      const cache = await resetScanCache();
      const dir = safetyDir();
      if (!dir) return '{"error":"尚未选择实时备份目录","files":[]}';
      const files = [];
      let copied = 0, failed = 0;
      try {
        for (const e of (await safetyFiles(dir)).sort(byName)) {
          const name = e.name, low = name.toLowerCase();
          if (isSafetyMetaName(name) || !low.startsWith('kaku_') || !low.includes('__') || (!low.endsWith('.png') && !low.endsWith('.json'))) continue;
          const dst = path.join(cache, 's' + copied + (low.endsWith('.png') ? '.png' : '.json'));
          try {
            await fsp.copyFile(e.full, dst);
            files.push({ name, path: dst, size: (await fsp.stat(dst)).size });
            copied++;
          } catch (x) { await fsp.rm(dst, { force: true }).catch(() => {}); failed++; }
        }
      } catch (e) { return JSON.stringify({ error: U.errMsg(e), files: [] }); }
      return JSON.stringify({ files, count: copied, readFailed: failed });
    },

    // —— 扫描目录 ——
    chooseFolder() {
      chooseInto('选择要扫描的文件夹', (p) => {
        const uri = U.fileUri(p);
        P.put('folder_scan', uri, p);
        ctx.evalInPage(`typeof onScanFolderChosen==='function'?onScanFolderChosen(${JSON.stringify(uri)}):(typeof renderFolderLib==='function'&&renderFolderLib())`);
      });
    },
    listFolders() {
      const all = P.all('folder_scan');
      return JSON.stringify(Object.keys(all).map((uri) => ({ uri, name: String(all[uri] || '') || '已授权文件夹' })));
    },
    removeFolder(uri) { P.remove('folder_scan', String(uri)); },
    async scanFolder(treeUri, offset, limit) {
      const cache = await resetScanCache();
      const skippedNames = [];
      const st = {
        offset: Math.max(0, U.toInt(offset)), limit: Math.max(1, U.toInt(limit)),
        eligible: 0, copied: 0, next: Math.max(0, U.toInt(offset)), unsupported: 0, oversized: 0, failed: 0,
        totalBytes: 0, hasMore: false, stopReason: '', files: [],
        skip(n) { if (skippedNames.length < 8) skippedNames.push(n); },
      };
      try {
        const root = P.get('folder_scan', String(treeUri), '');
        if (!root) throw new Error('该文件夹未授权，请重新添加');
        if (!(await isDir(root))) throw new Error('文件夹不存在或无法访问');
        await scanDocPage(root, '', cache, st);
      } catch (e) { return JSON.stringify({ error: U.errMsg(e), files: [] }); }
      return JSON.stringify({
        files: st.files, count: st.copied, nextOffset: st.next, hasMore: st.hasMore, stopReason: st.stopReason,
        scannedEligible: st.eligible, unsupported: st.unsupported, oversized: st.oversized, readFailed: st.failed, skippedNames,
      });
    },
    async readChunk(p, offset, len) {
      try {
        p = String(p);
        if (!(await U.isDirectChild(scanCache(), p))) return '';
        const n = Math.max(0, Math.min(U.toInt(len), 8 * MB));
        const b = await U.readAt(p, Math.max(0, U.toInt(offset)), n);
        return U.b64(b);
      } catch (e) { return ''; }
    },
    async clearScan() { await U.rmrf(scanCache()); },
  };

  return {
    methods,
    isBusy: () => !!tavernOut || !!safetyOut || personaCommitRunning,
    async cleanup() { await closeTavernOut(true); await closeSafetyOut(); await closeSafetyRead(); },
  };
}

module.exports = { createFolderBridge, isSafetyMetaName };
