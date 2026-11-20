'use strict';
// 与 MainActivity.java 对应的通用工具：文件名清理、路径授权检查、Base64、哈希等。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');

/** Java DownloadBridge.safePart：非 [A-Za-z0-9._-] 一律替换为 "_"。
 *  桌面版额外把只由点组成的结果（"."、".."）也替换掉，避免拼路径时跳出暂存目录。 */
function safePart(s) {
  let r = (s == null ? 'x' : String(s)).replace(/[^A-Za-z0-9._-]/g, '_');
  if (/^\.*$/.test(r)) r = r.replace(/\./g, '_') || '_';
  return r;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;

/** Java 版写入酒馆/安全库时用 [\/:*?"<>|] → "_"。
 *  Windows 下还要处理反斜杠、控制字符、结尾的点/空格和设备保留名，否则可能写到别的位置。 */
function safeFileName(name, fallback) {
  let s = (name == null ? fallback : String(name)).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  s = s.replace(/[. ]+$/g, (m) => '_'.repeat(m.length));
  if (!s || /^\.+$/.test(s)) s = fallback;
  if (WIN_RESERVED.test(s)) s = '_' + s;
  if (Buffer.byteLength(s, 'utf8') > 240) {
    const ext = path.extname(s).slice(0, 20);
    let base = s.slice(0, s.length - ext.length);
    while (Buffer.byteLength(base + ext, 'utf8') > 240) base = base.slice(0, -1);
    s = base + ext;
  }
  return s;
}

/** 只校验名称本身是否为“同一目录下的单个文件名”，不做替换（用于查找既有文件）。 */
function isPlainName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..') return false;
  return !/[\\/\u0000]/.test(name) && !name.includes(':');
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function toStr(v) { return v == null ? null : String(v); }
function toBool(v) { return v === true || v === 'true'; }

function b64decode(s) {
  if (s == null) throw new Error('null');
  return Buffer.from(String(s), 'base64');
}
function b64(buf) { return Buffer.from(buf).toString('base64'); }
function b64utf8(text) { return Buffer.from(String(text), 'utf8').toString('base64'); }

function errMsg(e) {
  if (!e) return 'unknown';
  return (e.message != null && e.message !== '') ? String(e.message) : String(e);
}

function fileUri(p) { return pathToFileURL(p).href; }
function uriToPath(uri) {
  if (typeof uri !== 'string' || !/^file:/i.test(uri)) throw new Error('无效的文件位置');
  return fileURLToPath(uri);
}

async function realpathOrNull(p) {
  try { return await fsp.realpath(p); } catch (e) { return null; }
}

/** target 解析符号链接后必须位于 root 之内（或等于 root）。 */
async function isWithin(root, target) {
  const r = await realpathOrNull(root);
  const t = await realpathOrNull(target);
  if (!r || !t) return false;
  const rel = path.relative(r, t);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** target 必须是 root 目录下的直接子项。 */
async function isDirectChild(root, target) {
  const r = await realpathOrNull(root);
  const t = await realpathOrNull(target);
  if (!r || !t) return false;
  const rel = path.relative(r, t);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep) && !rel.includes('/');
}

/** 列出目录第一层（不跟随符号链接 / junction）。
 *  Windows 上 OneDrive 等云端占位文件也带 reparse point，readdir 会把它们报成“链接”；
 *  这里再用 lstat 确认，只有真正的符号链接和 junction 才跳过。 */
async function listDir(dir) {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of ents) {
    const full = path.join(dir, e.name);
    let isFile = e.isFile(), isDir = e.isDirectory();
    if (e.isSymbolicLink() || (!isFile && !isDir)) {
      try {
        const st = await fsp.lstat(full);
        if (st.isSymbolicLink()) continue;
        isFile = st.isFile(); isDir = st.isDirectory();
      } catch (x) { continue; }
    }
    if (!isFile && !isDir) continue;
    out.push({ name: e.name, full, isFile, isDir });
  }
  return out;
}

async function findChild(dir, wanted, wantDir) {
  const low = String(wanted).toLowerCase();
  for (const e of await listDir(dir)) {
    if (e.name.toLowerCase() !== low) continue;
    if (wantDir === true && !e.isDir) continue;
    return e.full;
  }
  return null;
}

async function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p, { highWaterMark: 256 * 1024 });
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** 读取文件 offset 起最多 len 字节；超出文件末尾返回空 Buffer。 */
async function readAt(p, offset, len) {
  const fh = await fsp.open(p, 'r');
  try {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, offset + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } finally { await fh.close(); }
}

async function rmrf(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch (e) { return false; }
}

/** 目标目录中挑一个不冲突的文件名：name.ext → name (1).ext → … */
async function uniquePath(dir, name, reserved) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 10000; i++) {
    const n = i === 0 ? name : `${base} (${i})${ext}`;
    const full = path.join(dir, n);
    if (reserved && reserved.has(full.toLowerCase())) continue;
    if (!(await exists(full)) && !(await exists(full + '.part'))) return full;
  }
  throw new Error('无法创建文件');
}

async function freeBytes(dir) {
  try {
    const st = await fsp.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch (e) { return -1; }
}
async function totalBytes(dir) {
  try {
    const st = await fsp.statfs(dir);
    return Number(st.blocks) * Number(st.bsize);
  } catch (e) { return -1; }
}

module.exports = {
  safePart, safeFileName, isPlainName, toInt, toStr, toBool, b64decode, b64, b64utf8, errMsg,
  fileUri, uriToPath, isWithin, isDirectChild, listDir, findChild, sha256File, readAt, rmrf, exists,
  uniquePath, freeBytes, totalBytes, realpathOrNull,
};
