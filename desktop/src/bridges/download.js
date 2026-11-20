'use strict';
// AndroidDL —— 对应 MainActivity.DownloadBridge。
// 下载/导出：Android 写到 下载/卡库，桌面写到 %USERPROFILE%\Downloads\卡库；
// 先写 *.part，完成后改名，避免中断留下半个文件。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const U = require('../util');
const Z = require('../zip');

function createDownloadBridge(ctx) {
  const transferDir = () => { const d = path.join(ctx.paths.files, 'transfer_staging'); fs.mkdirSync(d, { recursive: true }); return d; };
  const stageFile = (taskId, fileId) => path.join(transferDir(), U.safePart(taskId), U.safePart(fileId));
  const stageJobs = new Map();
  const reserved = new Set();

  // —— 与 Java 相同：beginFile 和 beginStage 共用一个“分块写入”槽 ——
  let chunk = null; // { fh, tmp, final, kind: 'download'|'stage' }
  let zip = null;   // { writer, tmp, final, entryOpen }

  async function closeChunkQuietly(deletePartial) {
    const c = chunk; chunk = null;
    if (!c) return;
    try { await c.fh.close(); } catch (e) { /* ignore */ }
    if (c.kind === 'download') { reserved.delete(c.final.toLowerCase()); if (deletePartial) await fsp.rm(c.tmp, { force: true }).catch(() => {}); }
  }

  async function downloadTarget(fileName) {
    const dir = ctx.paths.downloads;
    await fsp.mkdir(dir, { recursive: true });
    const name = U.safeFileName(fileName, 'file.bin');
    const final = await U.uniquePath(dir, name, reserved);
    reserved.add(final.toLowerCase());
    return final;
  }

  async function commitDownload(tmp, final) {
    let target = final;
    if (await U.exists(target)) target = await U.uniquePath(path.dirname(final), path.basename(final), null);
    await fsp.rename(tmp, target);
    return target;
  }

  function setStageJob(id, state, done, total, error) {
    const o = { state, done, total };
    if (error != null) o.error = error;
    stageJobs.set(id, JSON.stringify(o));
  }

  async function copySelected(job, src, size, taskId, fileId) {
    const target = stageFile(taskId, fileId);
    let done = 0, inH = null, outH = null;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const free = await U.freeBytes(path.dirname(target));
      if (free >= 0 && free < size + 128 * 1024 * 1024) throw new Error('可用空间不足，至少需要文件大小再加128MB');
      inH = await fsp.open(src, 'r');
      outH = await fsp.open(target, 'w');
      const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
      for (;;) {
        const { bytesRead } = await inH.read(buf, 0, buf.length, null);
        if (!bytesRead) break;
        await outH.write(buf, 0, bytesRead);
        done += bytesRead;
        setStageJob(job, 'running', done, size, null);
      }
      await outH.sync().catch(() => {});
      setStageJob(job, 'done', done, size, null);
    } catch (e) {
      try { await outH?.close(); outH = null; } catch (x) { /* ignore */ }
      await fsp.rm(target, { force: true }).catch(() => {});
      setStageJob(job, 'error', done, size, U.errMsg(e));
    } finally {
      try { await inH?.close(); } catch (e) { /* ignore */ }
      try { await outH?.close(); } catch (e) { /* ignore */ }
      ctx.busy.delete(job);
    }
  }

  async function zipPage(taskId, fileId, offset, limit) {
    const out = {};
    const rows = [];
    try {
      let eligible = 0, skipped = 0;
      const cap = Math.max(1, Math.min(limit, 500));
      await Z.walkEntries(stageFile(taskId, fileId), (e) => {
        if (!Z.safeZipEntry(e)) { if (!e.isDirectory) skipped++; return true; }
        if (eligible >= offset && rows.length < cap) rows.push({ index: eligible, name: e.name, size: e.size, compressedSize: e.compressedSize });
        eligible++;
        return true;
      });
      out.total = eligible; out.skipped = skipped; out.entries = rows; out.next = Math.min(eligible, offset + rows.length);
    } catch (e) { out.error = U.errMsg(e); }
    return JSON.stringify(out);
  }

  const methods = {
    checkAppUpdate() { ctx.updater.check(); },

    beginSelectedStage(name, size, taskId, fileId) {
      name = U.toStr(name); size = U.toInt(size); taskId = U.toStr(taskId); fileId = U.toStr(fileId);
      const key = (name == null ? '' : name) + '\n' + size;
      const src = ctx.selectedFiles.get(key);
      ctx.selectedFiles.delete(key);
      if (!src) return '';
      let st;
      try { st = fs.statSync(src); } catch (e) { return ''; }
      if (!st.isFile() || st.size !== size) return '';
      const job = 'copy_' + Date.now() + '_' + Math.abs(hashCode(String(fileId)));
      setStageJob(job, 'running', 0, size, null);
      ctx.busy.add(job);
      copySelected(job, src, size, taskId, fileId);
      return job;
    },
    stageCopyStatus(jobId) { const s = stageJobs.get(String(jobId)); return s == null ? '{"state":"missing"}' : s; },

    listZipEntries(taskId, fileId, offset, limit) { return zipPage(U.toStr(taskId), U.toStr(fileId), U.toInt(offset), U.toInt(limit)); },

    async extractZipEntry(taskId, zipFileId, targetIndex, childFileId) {
      taskId = U.toStr(taskId); zipFileId = U.toStr(zipFileId); targetIndex = U.toInt(targetIndex); childFileId = U.toStr(childFileId);
      const out = {};
      const target = stageFile(taskId, childFileId);
      try {
        let found = false;
        let eligible = 0;
        await Z.walkEntries(stageFile(taskId, zipFileId), async (e, z) => {
          if (!Z.safeZipEntry(e)) return true;
          if (eligible++ !== targetIndex) return true;
          found = true;
          await fsp.mkdir(path.dirname(target), { recursive: true });
          const size = await Z.extractTo(z, e, target);
          out.id = childFileId; out.name = e.name; out.size = size;
          return false;
        });
        if (!found) throw new Error('ZIP条目不存在');
      } catch (e) {
        await fsp.rm(target, { force: true }).catch(() => {});
        out.error = U.errMsg(e);
      }
      return JSON.stringify(out);
    },

    async extractZipBatch(taskId, zipFileId, offset, maxItems, maxBytes) {
      taskId = U.toStr(taskId); zipFileId = U.toStr(zipFileId); offset = U.toInt(offset); maxBytes = U.toInt(maxBytes);
      // Java 版未使用 maxItems，这里保持一致。
      const out = {};
      const rows = [];
      try {
        let eligible = 0, batchBytes = 0;
        await Z.walkEntries(stageFile(taskId, zipFileId), async (e, z) => {
          if (!Z.safeZipEntry(e)) return true;
          if (eligible++ < offset) return true;
          if (rows.length > 0 && batchBytes + e.size > Math.max(1, maxBytes)) { eligible--; return false; }
          const childId = 'ze_' + U.safePart(zipFileId) + '_' + (eligible - 1);
          const target = stageFile(taskId, childId);
          try {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            const size = await Z.extractTo(z, e, target);
            rows.push({ index: eligible - 1, id: childId, name: e.name, size });
            batchBytes += size;
          } catch (itemError) { await fsp.rm(target, { force: true }).catch(() => {}); }
          return true;
        });
        out.entries = rows; out.next = eligible; out.bytes = batchBytes;
      } catch (e) { out.error = U.errMsg(e); }
      return JSON.stringify(out);
    },

    async deleteStageFile(taskId, fileId) { await fsp.rm(stageFile(U.toStr(taskId), U.toStr(fileId)), { force: true }).catch(() => {}); },
    stageFileSize(taskId, fileId) {
      try { return fs.statSync(stageFile(U.toStr(taskId), U.toStr(fileId))).size; } catch (e) { return e && e.code === 'ENOENT' ? 0 : -1; }
    },

    async beginFile(fileName) {
      try {
        await closeChunkQuietly(true);
        const final = await downloadTarget(U.toStr(fileName));
        const tmp = final + '.part';
        chunk = { fh: await fsp.open(tmp, 'w'), tmp, final, kind: 'download' };
        return true;
      } catch (e) { await closeChunkQuietly(true); return false; }
    },
    async appendChunk(b64) {
      try {
        if (!chunk) return false;
        await chunk.fh.write(U.b64decode(b64));
        return true;
      } catch (e) { return false; }
    },
    async endFile() {
      try {
        if (!chunk) return false;
        const c = chunk; chunk = null;
        await c.fh.close();
        if (c.kind === 'download') {
          reserved.delete(c.final.toLowerCase());
          const saved = await commitDownload(c.tmp, c.final);
          ctx.toast('已保存：' + saved);
        }
        return true;
      } catch (e) { return false; }
    },
    async abortFile() {
      const c = chunk; chunk = null;
      if (!c) return;
      try { await c.fh.close(); } catch (e) { /* ignore */ }
      if (c.kind === 'download') reserved.delete(c.final.toLowerCase());
      await fsp.rm(c.tmp, { force: true }).catch(() => {});
    },

    async beginZip(fileName) {
      try {
        await methods.abortZip();
        const final = await downloadTarget(U.toStr(fileName));
        const tmp = final + '.part';
        zip = { writer: new Z.ZipWriter(tmp), tmp, final };
        return true;
      } catch (e) { await methods.abortZip(); return false; }
    },
    beginZipEntry(name) {
      try {
        if (!zip) return false;
        name = name == null ? 'file.bin' : String(name).replace(/\\/g, '/').replace(/^\/+/, '');
        zip.writer.beginEntry(name);
        return true;
      } catch (e) { return false; }
    },
    async appendZipChunk(b64) {
      try {
        if (!zip || !zip.writer.entry) return false;
        await zip.writer.write(U.b64decode(b64));
        return true;
      } catch (e) { return false; }
    },
    endZipEntry() {
      try { if (!zip || !zip.writer.entry) return false; return zip.writer.endEntry(); } catch (e) { return false; }
    },
    async finishZip() {
      try {
        if (!zip) return false;
        const z = zip;
        await z.writer.finish();
        zip = null;
        reserved.delete(z.final.toLowerCase());
        const saved = await commitDownload(z.tmp, z.final);
        ctx.toast('已保存：' + saved);
        return true;
      } catch (e) { await methods.abortZip(); return false; }
    },
    async abortZip() {
      const z = zip; zip = null;
      if (!z) return;
      reserved.delete(z.final.toLowerCase());
      await z.writer.abort();
      await fsp.rm(z.tmp, { force: true }).catch(() => {});
    },

    async beginStage(taskId, fileId) {
      try {
        await closeChunkQuietly(true);
        const f = stageFile(U.toStr(taskId), U.toStr(fileId));
        await fsp.mkdir(path.dirname(f), { recursive: true });
        chunk = { fh: await fsp.open(f, 'w'), tmp: f, final: f, kind: 'stage' };
        return true;
      } catch (e) { await closeChunkQuietly(false); return false; }
    },
    appendStageChunk(b64) { return methods.appendChunk(b64); },
    async endStage() {
      try {
        if (!chunk) return false;
        const c = chunk; chunk = null;
        await c.fh.close();
        return true;
      } catch (e) { await closeChunkQuietly(false); return false; }
    },
    async readStageChunk(taskId, fileId, offset, len) {
      try {
        const n = Math.min(Math.max(1, U.toInt(len)), 512 * 1024);
        const b = await U.readAt(stageFile(U.toStr(taskId), U.toStr(fileId)), Math.max(0, U.toInt(offset)), n);
        return b.length ? U.b64(b) : '';
      } catch (e) { return ''; }
    },
    async clearStage(taskId) { await U.rmrf(path.join(transferDir(), U.safePart(U.toStr(taskId)))); },

    async saveBase64(base64Data, fileName) {
      let final = null;
      try {
        const bytes = U.b64decode(base64Data);
        final = await downloadTarget(U.toStr(fileName));
        const tmp = final + '.part';
        await fsp.writeFile(tmp, bytes);
        reserved.delete(final.toLowerCase());
        const saved = await commitDownload(tmp, final);
        ctx.toast('已保存：' + saved);
      } catch (e) {
        if (final) { reserved.delete(final.toLowerCase()); await fsp.rm(final + '.part', { force: true }).catch(() => {}); }
        ctx.toast('保存失败：' + U.errMsg(e));
      }
    },
  };

  return {
    methods,
    isBusy: () => !!chunk || !!zip,
  };
}

function hashCode(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; }

module.exports = { createDownloadBridge };
