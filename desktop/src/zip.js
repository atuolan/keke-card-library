'use strict';
// ZIP 读写。读取规则与 DownloadBridge.safeZipEntry 完全一致；条目名称只用于显示，从不拼成磁盘路径。
const fs = require('fs');
const fsp = fs.promises;
const yauzl = require('yauzl');
const yazl = require('yazl');
const { PassThrough } = require('stream');

const MAX_ENTRY = 32 * 1024 * 1024;

function supportedZipName(name) {
  const x = (name == null ? '' : String(name)).toLowerCase();
  return x.endsWith('.png') || x.endsWith('.json') || x.endsWith('.txt') || x.endsWith('.docx') || x.endsWith('.md') || x.endsWith('.jsonl');
}

/** Java: !isDirectory && supportedZipName && 0<=size<=32MB && packed>=0 && (size==0 || packed>0 && size/max(1,packed)<=200) */
function safeZipEntry(e) {
  if (!e) return false;
  const size = e.size, packed = e.compressedSize;
  return !e.isDirectory && supportedZipName(e.name) && size >= 0 && size <= MAX_ENTRY && packed >= 0 &&
    (size === 0 || (packed > 0 && Math.floor(size / Math.max(1, packed)) <= 200));
}

let gbk = null;
try { gbk = new TextDecoder('gbk'); } catch (e) { gbk = null; }
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** 有 UTF-8 标志或本身是合法 UTF-8 → UTF-8；否则按 GBK（Windows 中文压缩软件常见），再不行按 latin1。 */
function decodeName(buf, flags) {
  if (flags & 0x800) return buf.toString('utf8');
  try { return utf8Strict.decode(buf); } catch (e) { /* not utf-8 */ }
  if (gbk) { try { return gbk.decode(buf); } catch (e) { /* ignore */ } }
  return buf.toString('latin1');
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true, strictFileNames: false }, (err, z) => err ? reject(err) : resolve(z));
  });
}

/** 依中央目录顺序遍历条目；visit 返回 false 时提前结束。 */
async function walkEntries(file, visit) {
  const z = await openZip(file);
  try {
    await new Promise((resolve, reject) => {
      let stopped = false;
      z.on('entry', async (raw) => {
        if (stopped) return;
        const name = decodeName(raw.fileName, raw.generalPurposeBitFlag);
        const entry = {
          raw, name,
          isDirectory: /\/$/.test(name),
          size: raw.uncompressedSize,
          compressedSize: raw.compressedSize,
        };
        try {
          const go = await visit(entry, z);
          if (go === false) { stopped = true; resolve(); return; }
          z.readEntry();
        } catch (e) { stopped = true; reject(e); }
      });
      z.on('end', () => { if (!stopped) resolve(); });
      z.on('error', (e) => { if (!stopped) { stopped = true; reject(e); } });
      z.readEntry();
    });
  } finally { try { z.close(); } catch (e) { /* ignore */ } }
}

/** 解压单个条目到 target，实际字节超过 32MB 立即中止（不信任中央目录里声明的大小）。 */
function extractTo(z, entry, target) {
  return new Promise((resolve, reject) => {
    z.openReadStream(entry.raw, (err, rs) => {
      if (err) { reject(err); return; }
      const out = fs.createWriteStream(target, { flags: 'w' });
      let done = 0, failed = false;
      const fail = (e) => {
        if (failed) return;
        failed = true;
        try { rs.destroy(); } catch (x) { /* ignore */ }
        out.destroy();
        reject(e);
      };
      rs.on('data', (c) => {
        done += c.length;
        if (done > MAX_ENTRY) { fail(new Error('ZIP条目超过32MB')); return; }
        if (!out.write(c)) { rs.pause(); out.once('drain', () => rs.resume()); }
      });
      rs.on('error', fail);
      out.on('error', fail);
      rs.on('end', () => { if (!failed) out.end(() => resolve(done)); });
    });
  });
}

/** 流式 ZIP 写入器，对应 Java ZipOutputStream 的 putNextEntry/write/closeEntry/finish。 */
class ZipWriter {
  constructor(file) {
    this.file = file;
    this.zip = new yazl.ZipFile();
    this.out = fs.createWriteStream(file, { flags: 'w' });
    this.closed = new Promise((resolve, reject) => {
      this.out.on('close', resolve);
      this.out.on('error', reject);
      this.zip.outputStream.on('error', reject);
    });
    this.closed.catch(() => {});
    this.zip.outputStream.pipe(this.out);
    this.entry = null;
    this.names = new Set();
  }
  beginEntry(name) {
    if (this.entry) this.endEntry();
    if (this.names.has(name)) throw new Error('duplicate entry: ' + name);
    const pass = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
    this.zip.addReadStream(pass, name, { compress: true, mtime: new Date() });
    this.names.add(name);
    this.entry = pass;
  }
  async write(buf) {
    if (!this.entry) throw new Error('no entry');
    if (!this.entry.write(buf)) await new Promise((r) => this.entry.once('drain', r));
  }
  endEntry() {
    if (!this.entry) return false;
    this.entry.end();
    this.entry = null;
    return true;
  }
  async finish() {
    if (this.entry) this.endEntry();
    this.zip.end();
    await this.closed;
  }
  async abort() {
    try { if (this.entry) this.entry.destroy(); } catch (e) { /* ignore */ }
    try { this.zip.outputStream.unpipe(this.out); } catch (e) { /* ignore */ }
    await new Promise((r) => { this.out.once('close', r); this.out.destroy(); setTimeout(r, 1000); });
    try { await fsp.unlink(this.file); } catch (e) { /* ignore */ }
  }
}

module.exports = { safeZipEntry, supportedZipName, decodeName, walkEntries, extractTo, ZipWriter, MAX_ENTRY };
