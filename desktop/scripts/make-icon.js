'use strict';
// 把 app/src/main/res/mipmap-xxxhdpi/ic_launcher.png 转成 Windows .ico（16~256 多尺寸，PNG 压缩条目）。
// 原图只有 192×192，256 尺寸用双三次插值放大；electron-builder 要求图标至少 256×256。
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

function cubic(t) {
  const a = -0.5, x = Math.abs(t);
  if (x <= 1) return (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1;
  if (x < 2) return a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a;
  return 0;
}

/** 缩放：缩小用区域平均（抗锯齿），放大用双三次。输入输出均为 RGBA。 */
function resize(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const sx = sw / dw, sy = sh / dh;
  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const x0 = x * sx, x1 = x0 + sx, y0 = y * sy, y1 = y0 + sy;
      const acc = [0, 0, 0, 0]; let wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
        const w = (Math.min(x1, xx + 1) - Math.max(x0, xx)) * (Math.min(y1, yy + 1) - Math.max(y0, yy));
        if (w <= 0) continue;
        const i = (yy * sw + xx) * 4;
        const a = src[i + 3] / 255;
        acc[0] += src[i] * a * w; acc[1] += src[i + 1] * a * w; acc[2] += src[i + 2] * a * w; acc[3] += src[i + 3] * w; wsum += w;
      }
      const o = (y * dw + x) * 4, alpha = acc[3] / wsum;
      for (let c = 0; c < 3; c++) out[o + c] = alpha > 0 ? Math.round(Math.min(255, acc[c] / wsum / (alpha / 255))) : 0;
      out[o + 3] = Math.round(alpha);
    }
    return out;
  }
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const fx = (x + 0.5) * sx - 0.5, fy = (y + 0.5) * sy - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const acc = [0, 0, 0, 0]; let wsum = 0;
    for (let m = -1; m <= 2; m++) for (let n = -1; n <= 2; n++) {
      const px = Math.min(sw - 1, Math.max(0, ix + n)), py = Math.min(sh - 1, Math.max(0, iy + m));
      const w = cubic(fx - (ix + n)) * cubic(fy - (iy + m));
      const i = (py * sw + px) * 4;
      for (let c = 0; c < 4; c++) acc[c] += src[i + c] * w;
      wsum += w;
    }
    const o = (y * dw + x) * 4;
    for (let c = 0; c < 4; c++) out[o + c] = Math.max(0, Math.min(255, Math.round(acc[c] / wsum)));
  }
  return out;
}

function makeIco(srcPng, outIco, sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]) {
  const src = PNG.sync.read(fs.readFileSync(srcPng));
  const images = sizes.map((s) => {
    const png = new PNG({ width: s, height: s });
    resize(src.data, src.width, src.height, s, s).copy(png.data);
    return { size: s, data: PNG.sync.write(png, { colorType: 6 }) };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((img, i) => {
    const o = i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, o); dir.writeUInt8(img.size >= 256 ? 0 : img.size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3); dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(img.data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += img.data.length;
  });
  fs.mkdirSync(path.dirname(outIco), { recursive: true });
  fs.writeFileSync(outIco, Buffer.concat([header, dir, ...images.map((x) => x.data)]));
  return { sizes, bytes: offset, source: `${src.width}x${src.height}` };
}

module.exports = { makeIco };

if (require.main === module) {
  const root = path.resolve(__dirname, '..', '..');
  const r = makeIco(path.join(root, 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi', 'ic_launcher.png'), path.join(__dirname, '..', 'build', 'icon.ico'));
  console.log('icon.ico', r);
}
