'use strict';
// 浏览器版端到端测试：用 Chromium 直接打开建置出的 HTML 文件（file://，与用户双击打开相同）。
// 先执行 npm run build；也可以用 KAKU_WEB_HTML 指定要测的文件。
// 截图与结果写到 test-output/。
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { parseGradle } = require('../build');

const WEB = path.resolve(__dirname, '..');
const ROOT = path.resolve(WEB, '..');
const OUT = path.join(WEB, 'test-output');
const version = parseGradle(fs.readFileSync(path.join(ROOT, 'app', 'build.gradle.kts'), 'utf8'));
const HTML = process.env.KAKU_WEB_HTML || path.join(WEB, 'dist', `kaku-web-${version.name}.html`);

// ---------- 测试数据：带 chara 元数据的 PNG 角色卡 ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function charaJson(name) {
  const data = { name, description: '这是 ' + name + ' 的测试描述。', personality: '冷静', scenario: '测试场景', first_mes: '你好，我是' + name, mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: ['测试'], creator: 'kaku-web-e2e', character_version: '1', extensions: {} };
  return { spec: 'chara_card_v2', spec_version: '2.0', ...data, data };
}
function cardPng(name) {
  const w = 32, h = 32, seed = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (1 + w * 4) + 1 + x * 4; raw[o] = (seed * 37 + x) & 255; raw[o + 1] = (seed * 11 + y) & 255; raw[o + 2] = (x * y) & 255; raw[o + 3] = 255; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const text = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(Buffer.from(JSON.stringify(charaJson(name)), 'utf8').toString('base64'), 'latin1')]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('tEXt', text), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// 不压缩（stored）的 ZIP，文件名用 UTF-8
function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nb = Buffer.from(name, 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb);
    offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function readChara(buf) {
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt') { const i = data.indexOf(0); if (data.toString('latin1', 0, i) === 'chara') return JSON.parse(Buffer.from(data.toString('latin1', i + 1), 'base64').toString('utf8')); }
    p += 12 + len;
  }
  return null;
}

// ---------- 测试框架 ----------
const ALL = ['白夜', '青岚', 'ZIP甲', 'ZIP乙'].sort();
const results = [];
const problems = [];
let context, page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pe = (fn, arg) => page.evaluate(fn, arg);
async function waitPage(fn, arg, timeout = 30000) { await page.waitForFunction(fn, arg, { timeout, polling: 100 }); }
const cardCount = () => pe(() => S.cards.filter((c) => !c._delAt).length);
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log('PASS', name, (Date.now() - t0) + 'ms'); }
  catch (e) {
    results.push({ name, ok: false, error: String(e && e.stack || e) });
    console.log('FAIL', name, '\n  ', e && e.stack || e);
    try { await page.screenshot({ path: path.join(OUT, 'fail-' + results.length + '.png') }); } catch (_) { /* 页面可能已关闭 */ }
  }
}

async function openBrowser(userDataDir) {
  // Linux 上 LANG 不是 UTF-8 时，Chromium 处理中文路径会出错（IndexedDB 打不开、选不了中文文件名），测试统一用 UTF-8
  const lang = /utf-?8/i.test(process.env.LANG || '') ? process.env.LANG : 'C.UTF-8';
  context = await chromium.launchPersistentContext(userDataDir, { acceptDownloads: true, viewport: { width: 420, height: 860 }, env: { ...process.env, LANG: lang }, executablePath: process.env.KAKU_CHROMIUM_PATH || undefined });
  context.on('request', (r) => { if (!/^(file|data|blob|about|chrome-extension):/.test(r.url())) problems.push('对外请求：' + r.url()); });
  context.on('page', watchPage);
  for (const p of context.pages()) watchPage(p);
}
function watchPage(p) {
  p.on('pageerror', (e) => problems.push('页面错误：' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') problems.push('控制台错误：' + m.text()); });
  p.on('dialog', (d) => d.accept());
}
async function openFile(file) {
  page = context.pages()[0] || await context.newPage();
  await page.goto(pathToFileURL(file).href);
  await waitPage(() => typeof S !== 'undefined' && typeof db !== 'undefined' && db && typeof startImport === 'function' && document.documentElement.hasAttribute('data-kaku-web'));
  await sleep(800);
  if (await pe(() => document.body.innerText.includes('初始化失败'))) throw new Error('卡库初始化失败');
}

async function main() {
  if (!fs.existsSync(HTML)) throw new Error('找不到 ' + HTML + '，请先执行 npm run build');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaku-web-e2e-'));
  const fixtures = path.join(tmp, '测试卡');
  fs.mkdirSync(fixtures);
  fs.writeFileSync(path.join(fixtures, '青岚.png'), cardPng('青岚'));
  fs.writeFileSync(path.join(fixtures, '白夜.json'), JSON.stringify(charaJson('白夜')));
  fs.writeFileSync(path.join(fixtures, '角色包.zip'), makeZip([['角色包/ZIP甲.png', cardPng('ZIP甲')], ['角色包/ZIP乙.png', cardPng('ZIP乙')]]));
  const userDataDir = path.join(tmp, '浏览器资料');
  console.log('测试文件：', HTML);

  await openBrowser(userDataDir);
  await openFile(HTML);

  await step('启动：标题与版本号、没有原生桥接、外壳已生效', async () => {
    assert.strictEqual(await page.title(), '克克卡库 · v' + version.name);
    assert.strictEqual((await page.textContent('.logo-v')).trim().toLowerCase(), 'v' + version.name);
    assert.strictEqual(await pe(() => document.getElementById('kaku-web-shell')?.dataset.version), version.name);
    assert.deepStrictEqual(await pe(() => ['AndroidDL', 'StHttpBridge', 'AndroidFolder', 'AndroidAI', 'AndroidGuard', 'AndroidDiagnosis', 'AndroidNav', 'AndroidPicker'].filter((k) => k in window)), []);
    assert.strictEqual(await cardCount(), 0);
    await page.screenshot({ path: path.join(OUT, '01-首页.png') });
  });

  await step('设置页：浏览器用不了的板块与对应的快速查找按钮隐藏、安卓专属按钮变灰、数据位置说明改为浏览器', async () => {
    await pe(() => openSettings());
    await sleep(600);
    const pages = {};
    for (const tab of await page.$$('.settings-page-tab')) {
      const key = await tab.getAttribute('data-page');
      await tab.click();
      await sleep(300);
      pages[key] = await pe(() => ({
        cards: [...document.querySelectorAll('#settingsModal .set-card')].filter((c) => c.getClientRects().length).map((c) => (c.querySelector('h4')?.textContent || '').trim()),
        quick: [...document.querySelectorAll('#settingsQuickNav .settings-quick-item')].map((b) => b.textContent.trim()),
      }));
      await page.screenshot({ path: path.join(OUT, `02-设置-${key}.png`) });
    }
    assert.deepStrictEqual(Object.keys(pages).sort(), ['diagnosis', 'organize', 'safety', 'smart']);
    const visible = Object.values(pages).flatMap((p) => p.cards);
    const quick = Object.values(pages).flatMap((p) => p.quick);
    for (const re of [/Local Tavern/i, /Cloud Sync/i, /Import & Folder Scan/i, /Data & Safety/i]) assert.ok(!visible.some((t) => re.test(t)), '已隐藏 ' + re);
    for (const re of [/Backup & Restore/i, /Style Studio/i, /AI Organizer/i, /Chat Logs/i, /AI Diagnosis/i, /Recycle Bin/i]) assert.ok(visible.some((t) => re.test(t)), '仍显示 ' + re);
    for (const name of ['酒馆互通', '云同步', '导入与文件夹扫描', '卡库数据与安全']) assert.ok(!quick.includes(name), '快速查找里没有 ' + name + '：' + quick.join(' / '));
    for (const name of ['备份与恢复', '风格工坊', 'AI整理', '聊天记录库']) assert.ok(quick.includes(name), '快速查找里仍有 ' + name + '：' + quick.join(' / '));
    const s = await pe(() => {
      const btn = (re) => [...document.querySelectorAll('button[onclick]')].filter((b) => re.test(b.getAttribute('onclick'))).map((b) => b.disabled);
      return { launcher: btn(/openLauncherIcons/), update: btn(/checkAppUpdate/), location: document.querySelector('[data-kaku-web-location]')?.textContent || '' };
    });
    assert.deepStrictEqual(s.launcher, [true]);
    assert.deepStrictEqual(s.update, [true]);
    assert.match(s.location, /浏览器的网站存储/);
    assert.ok(!/应用私有|Download \/ 卡库/.test(s.location), '不再显示安卓的数据位置');
    await pe(() => closeModal('settingsModal'));
  });

  await step('导入：选择 PNG、JSON 角色卡和含 2 张卡的 ZIP → 预检 → 确认写入', async () => {
    await pe(() => openImport());
    await page.setInputFiles('#fileInput', ['青岚.png', '白夜.json', '角色包.zip'].map((n) => path.join(fixtures, n)));
    await waitPage(() => !importStageBusy && pendFiles.length === 3);
    await pe(() => startImport());
    await waitPage(() => pendingImportReview && pendingImportReview.items.length === 4, null, 60000);
    await pe(() => confirmImportReview());
    await waitPage(() => S.cards.filter((c) => !c._delAt).length === 4, null, 60000);
    assert.deepStrictEqual((await pe(() => S.cards.map((c) => c.name))).sort(), ALL);
    await sleep(500);
    await page.screenshot({ path: path.join(OUT, '03-导入后.png') });
  });

  let backupFile;
  await step('导出：单张原文件与完整备份都走浏览器下载', async () => {
    const id = await pe(() => S.cards.find((c) => c.name === '青岚').id);
    const [png] = await Promise.all([page.waitForEvent('download'), pe((id) => exportCard(id, 'orig'), id)]);
    const pngPath = path.join(tmp, png.suggestedFilename());
    await png.saveAs(pngPath);
    assert.match(png.suggestedFilename(), /青岚.*\.png$/);
    assert.strictEqual(readChara(fs.readFileSync(pngPath)).data.name, '青岚');
    const [backup] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), pe(() => exportAllData())]);
    backupFile = path.join(tmp, backup.suggestedFilename());
    await backup.saveAs(backupFile);
    assert.match(backup.suggestedFilename(), /^卡库备份_.*\.json$/);
    const json = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    assert.deepStrictEqual(json.cards.map((c) => c.name).sort(), ALL);
  });

  await step('关闭浏览器再打开：卡片仍在（数据存在浏览器里）', async () => {
    await context.close();
    await openBrowser(userDataDir);
    await openFile(HTML);
    assert.strictEqual(await cardCount(), 4);
  });

  await step('换成放在别处、改了名字的新版文件：Chromium 里仍读到同一份数据', async () => {
    const moved = path.join(tmp, '另一个文件夹', `kaku-web-新版.html`);
    fs.mkdirSync(path.dirname(moved));
    fs.copyFileSync(HTML, moved);
    await openFile(moved);
    assert.strictEqual(await cardCount(), 4);
  });

  await step('清空卡库后用备份文件恢复', async () => {
    await pe(() => { window.confirmDialog = async () => true; });
    await pe(() => clearAllData(false));
    await waitPage(() => S.cards.length === 0);
    await page.setInputFiles('#restoreInput', backupFile);
    await waitPage(() => S.cards.filter((c) => !c._delAt).length === 4, null, 60000);
    assert.deepStrictEqual((await pe(() => S.cards.map((c) => c.name))).sort(), ALL);
  });

  await step('桌面宽度：首页与设置页截图', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, '04-桌面宽度.png') });
    await pe(() => openSettings());
    await sleep(600);
    await page.screenshot({ path: path.join(OUT, '05-桌面宽度设置.png') });
  });

  await step('全程没有对外网络请求、没有页面错误', async () => {
    assert.deepStrictEqual(problems, []);
  });

  await context.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ html: HTML, version, results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try { await context?.close(); } catch (_) { /* 忽略 */ }
  process.exit(1);
});
