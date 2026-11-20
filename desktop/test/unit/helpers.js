'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

function tmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'kaku-unit-')); }

/** 不依赖 Electron 的假 ctx，用于直接测试桥的逻辑。 */
function fakeCtx(root) {
  const { Prefs } = require('../../src/prefs');
  const toasts = [];
  const evals = [];
  const ctx = {
    paths: {
      userData: root, files: path.join(root, 'files'), cache: path.join(root, 'cache'), prefs: path.join(root, 'prefs'),
      downloads: path.join(root, 'Downloads', '卡库'), assets: path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'main', 'assets'),
    },
    busy: new Set(), selectedFiles: new Map(), sessions: {}, version: { name: '4.1.4', code: 414 },
    toast: (m) => toasts.push(m), evalInPage: (c) => evals.push(c),
    updater: { check() {} }, toasts, evals,
    chooseDirectory: async () => null, setWindowIcon() {}, closeWindow() {},
  };
  fs.mkdirSync(ctx.paths.cache, { recursive: true });
  ctx.prefs = new Prefs(ctx.paths.prefs);
  return ctx;
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** 手工构造 ZIP（可控制文件名字节、UTF-8 标志、声明大小），用于安全规则测试。 */
function buildZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const data = e.data || Buffer.alloc(0);
    const method = e.deflate ? 8 : 0;
    const packed = method === 8 ? zlib.deflateRawSync(data) : data;
    const flags = e.utf8 ? 0x800 : 0;
    const size = e.declaredSize != null ? e.declaredSize : data.length;
    const csize = e.declaredPacked != null ? e.declaredPacked : packed.length;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, packed);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { tmpdir, fakeCtx, buildZip, crc32 };
