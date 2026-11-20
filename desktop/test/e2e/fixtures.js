'use strict';
// 测试数据：带 chara 元数据的真实 PNG 角色卡、ZIP 等。
const zlib = require('zlib');
const { PNG } = require('pngjs');
const yazl = require('yazl');
const fs = require('fs');

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 生成角色卡 PNG。padBytes>0 时额外塞一个不压缩的私有块，用来制造大文件。 */
function cardPng(name, opts = {}) {
  const w = opts.size || 48, h = opts.size || 48;
  const png = new PNG({ width: w, height: h });
  const seed = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = (seed * 37 + i) & 255; png.data[i * 4 + 1] = (seed * 11) & 255; png.data[i * 4 + 2] = (i * 3) & 255; png.data[i * 4 + 3] = 255;
  }
  const base = PNG.sync.write(png);
  const card = {
    spec: 'chara_card_v2', spec_version: '2.0', name,
    description: opts.description || ('这是 ' + name + ' 的测试描述。'),
    personality: '冷静', scenario: '测试场景', first_mes: '你好，我是' + name, mes_example: '',
    tags: opts.tags || ['测试'],
    data: {
      name, description: opts.description || ('这是 ' + name + ' 的测试描述。'), personality: '冷静', scenario: '测试场景',
      first_mes: '你好，我是' + name, mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: opts.tags || ['测试'], creator: 'kaku-e2e', character_version: '1', extensions: {},
    },
  };
  const text = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'latin1')]);
  const iendAt = base.length - 12;
  const extra = [chunk('tEXt', text)];
  if (opts.padBytes) extra.push(chunk('kaPd', Buffer.alloc(opts.padBytes, 7)));
  return Buffer.concat([base.subarray(0, iendAt), ...extra, base.subarray(iendAt)]);
}

function readChara(buf) {
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'tEXt') {
      const data = buf.subarray(off + 8, off + 8 + len);
      const z = data.indexOf(0);
      if (data.toString('latin1', 0, z) === 'chara') return JSON.parse(Buffer.from(data.toString('latin1', z + 1), 'base64').toString('utf8'));
    }
    off += 12 + len;
  }
  return null;
}

function makeZip(file, entries) {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const e of entries) z.addBuffer(e.data, e.name, { compress: e.compress !== false });
    z.end();
    const out = fs.createWriteStream(file);
    z.outputStream.pipe(out);
    out.on('close', resolve);
    out.on('error', reject);
  });
}

module.exports = { cardPng, readChara, makeZip, crc32 };
