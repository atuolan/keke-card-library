'use strict';
// 桌面版端到端测试：启动真正的 Electron 应用（同一份 main/preload/index.html），
// 通过页面自己的函数和按钮流程，逐个桥实际跑一遍。系统对话框在主进程里替换成返回测试目录。
// 用法（Linux 需 Xvfb）：xvfb-run -a node test/e2e/run.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright');
const { cardPng, readChara } = require('./fixtures');
const { buildZip } = require('../unit/helpers');
const { startSillyTavern, startOpenAI, startWebDav } = require('./mock-servers');
const { walkEntries } = require('../../src/zip');
const { parseGradle } = require('../../src/version');

const DESKTOP = path.resolve(__dirname, '..', '..');
const OUT = path.join(DESKTOP, 'test-output');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kaku-e2e-'));
const D = {
  userData: path.join(ROOT, 'userData'), downloads: path.join(ROOT, 'Downloads', '卡库'), fixtures: path.join(ROOT, 'fixtures'),
  scan: path.join(ROOT, '扫描目录'), st: path.join(ROOT, 'SillyTavern', 'data', 'default-user'), safety: path.join(ROOT, '实时备份'),
  remoteChars: path.join(ROOT, 'st-server-characters'),
};
for (const d of Object.values(D)) fs.mkdirSync(d, { recursive: true });

const results = [];
let app, page, st, ai, dav;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pe = (fn, arg) => page.evaluate(fn, arg);
const waitPage = (fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
async function waitFile(dir, re, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    const hit = fs.existsSync(dir) && fs.readdirSync(dir).find((n) => re.test(n) && !n.endsWith('.part'));
    if (hit) return path.join(dir, hit);
    if (Date.now() - t0 > timeout) throw new Error('等待文件超时：' + re);
    await sleep(100);
  }
}
const nativeToast = () => pe(() => document.querySelector('[data-kaku-native-toast]')?.shadowRoot?.textContent || '');
async function waitToast(re, timeout = 20000) {
  const t0 = Date.now();
  for (;;) { const t = await nativeToast(); if (re.test(t)) return t; if (Date.now() - t0 > timeout) throw new Error('等待提示超时：' + re + '，当前：' + t); await sleep(100); }
}
const nextDir = (p) => app.evaluate((e, p) => { global.__kakuNextDir = p; }, p);
// 与用户在系统文件对话框中选择文件等效：通过 CDP 把磁盘路径交给 <input type=file>（会触发 change 事件）
async function chooseFiles(selector, paths) {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [].concat(paths) });
  await cdp.detach();
}
const cardCount = () => pe(() => S.cards.filter((c) => !c._delAt).length);

async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log('PASS', name, (Date.now() - t0) + 'ms'); }
  catch (e) {
    results.push({ name, ok: false, error: String(e && e.stack || e) });
    console.log('FAIL', name, '\n   ', String(e && e.stack || e).split('\n').slice(0, 6).join('\n    '));
    try { await page.screenshot({ path: path.join(OUT, (process.env.KAKU_E2E_EXECUTABLE ? 'packaged' : 'dev') + '-fail-' + results.length + '.png') }); } catch (x) { /* ignore */ }
  }
}

async function fixtures() {
  for (const n of ['青岚', '白夜']) fs.writeFileSync(path.join(D.fixtures, n + '.png'), cardPng(n));
  // 手工构造 ZIP（含 ../ 条目名，yazl 不允许写这种名字）
  fs.writeFileSync(path.join(D.fixtures, '角色包.zip'), buildZip([
    { name: '包/甲.png', data: cardPng('ZIP甲'), utf8: true, deflate: true }, { name: '包/乙.png', data: cardPng('ZIP乙'), utf8: true, deflate: true },
    { name: '丙.png', data: cardPng('ZIP丙'), utf8: true }, { name: 'virus.exe', data: Buffer.from('MZ') },
    { name: '../../逃逸.png', data: cardPng('ZIP逃逸'), utf8: true, deflate: true },
  ]));
  // 扫描目录：嵌套、不支持格式、安全库元数据
  fs.mkdirSync(path.join(D.scan, '子目录'), { recursive: true });
  fs.writeFileSync(path.join(D.scan, '扫描一.png'), cardPng('扫描一'));
  fs.writeFileSync(path.join(D.scan, '子目录', '扫描二.png'), cardPng('扫描二'));
  fs.writeFileSync(path.join(D.scan, '说明.txt'), 'hello');
  fs.writeFileSync(path.join(D.scan, 'kaku_meta_x.json'), '{}');
  // 酒馆服务器上的角色：一张普通卡 + 一张 >4MB 的大卡（走落盘分块读回）
  fs.writeFileSync(path.join(D.remoteChars, '酒馆远端.png'), cardPng('酒馆远端'));
  fs.writeFileSync(path.join(D.remoteChars, '超大远端.png'), cardPng('超大远端', { padBytes: 5 * 1024 * 1024 }));
  // 酒馆数据目录：default-user/characters + settings.json + User Avatars
  fs.mkdirSync(path.join(D.st, 'characters'), { recursive: true });
  fs.mkdirSync(path.join(D.st, 'User Avatars'), { recursive: true });
  fs.writeFileSync(path.join(D.st, 'characters', '目录远端.png'), cardPng('目录远端'));
  fs.writeFileSync(path.join(D.st, 'User Avatars', 'user-default.png'), cardPng('默认用户'));
  fs.writeFileSync(path.join(D.st, 'settings.json'), JSON.stringify({
    firstRun: false, currentVersion: '1.19.0', big_number: 12345678901234567890,
    power_user: { theme: 'Default', personas: { 'user-default.png': '旅人' }, persona_descriptions: { 'user-default.png': { description: '一位旅人', position: 0, depth: 2, role: 0, lorebook: '', title: '' } }, default_persona: 'user-default.png' },
    extension_settings: { note: '保持不变' },
  }, null, 4).replace('12345678901234567000', '12345678901234567890'));
}

async function launch() {
  // KAKU_E2E_EXECUTABLE=打包后的可执行文件：对打包产物跑同一套测试
  const packaged = process.env.KAKU_E2E_EXECUTABLE;
  app = await _electron.launch({
    executablePath: packaged || require('electron'),
    args: packaged ? ['--no-sandbox'] : ['--no-sandbox', DESKTOP],
    cwd: DESKTOP,
    // Linux 下 Chromium 需要 UTF-8 locale 才能处理中文路径（Windows 原生 UTF-16，不受影响）
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', KAKU_USER_DATA_DIR: D.userData, KAKU_DOWNLOADS_DIR: D.downloads },
  });
  app.process().stderr.on('data', (d) => { const s = String(d); if (/Error|error/.test(s) && !/dbus|Gtk|bus\.cc|NODE_OPTION|viz_main|gpu|Debugger/.test(s)) process.stderr.write('[main] ' + s); });
  await app.evaluate(({ dialog, shell }) => {
    global.__kakuOpened = []; global.__kakuBoxes = []; global.__kakuNextDir = null;
    dialog.showOpenDialog = async () => (global.__kakuNextDir ? { canceled: false, filePaths: [global.__kakuNextDir] } : { canceled: true, filePaths: [] });
    shell.openExternal = async (u) => { global.__kakuOpened.push(u); };
    dialog.showMessageBox = async (w, o) => { global.__kakuBoxes.push(o || w); return { response: 0 }; };
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForLoadState('load');
  await waitPage(() => typeof S !== 'undefined' && typeof db !== 'undefined' && db && typeof startImport === 'function');
  // 页面自己的确认框一律点“确定”
  await pe(() => { window.confirmDialog = async () => true; });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await fixtures();
  st = await startSillyTavern({ charactersDir: D.remoteChars, basicUser: 'kaku', basicPassword: 'p@ss:word' });
  ai = await startOpenAI();
  // 用本机非回环地址的 http 连接，顺便覆盖“安全来源页面访问 http 地址”（混合内容）的情况，例如局域网 NAS
  const lanIp = Object.values(os.networkInterfaces()).flat().find((x) => x && x.family === 'IPv4' && !x.internal)?.address || '127.0.0.1';
  dav = await startWebDav({ user: 'kaku@example.com', password: 'app-pass', host: lanIp });
  await launch();

  await step('启动：8 个桥存在、页面没有 Node 权限、存储哨兵、诊断脱敏、图标、外链', async () => {
    await waitPage(() => JSON.parse(AndroidDiagnosis.environmentReport()).recentEvents.some((e) => e.module === 'startup_checkpoint'));
    const r = await pe(() => {
      const names = ['AndroidDL', 'StHttpBridge', 'AndroidFolder', 'AndroidAI', 'AndroidGuard', 'AndroidDiagnosis', 'AndroidNav', 'AndroidPicker'];
      const out = { present: names.filter((n) => window[n] && typeof window[n] === 'object'), noNode: typeof require === 'undefined' && typeof process === 'undefined' };
      AndroidGuard.updateCardCount(3); out.guard = JSON.parse(AndroidGuard.status()); AndroidGuard.clearCards(); out.guardCleared = JSON.parse(AndroidGuard.status());
      out.iconBad = AndroidFolder.setLauncherIcon(9); out.iconOk = AndroidFolder.setLauncherIcon(3); out.icon = AndroidFolder.getLauncherIcon(); AndroidFolder.setLauncherIcon(2);
      AndroidPicker.setMultiple(true); AndroidPicker.setMode('other');
      AndroidDiagnosis.record('error', 'e2e_test', 'C:\\Users\\bob\\卡.png Bearer abc sk-abcdefghij https://x.y/z bob@mail.com');
      const rep = JSON.parse(AndroidDiagnosis.environmentReport());
      out.ev = rep.recentEvents.filter((e) => e.module === 'e2e_test').pop();
      out.startup = rep.recentEvents.some((e) => e.module === 'startup_checkpoint');
      out.rep = { source: rep.source, pickers: rep.pickers, free: rep.storage.privateFreeMB, safety: rep.safety, appVersion: rep.appVersion };
      AndroidNav.openUrl('https://example.com/a?b=1'); AndroidNav.openUrl('file:///etc/passwd'); AndroidNav.openUrl('javascript:alert(1)');
      return out;
    });
    assert.strictEqual(r.present.length, 8);
    assert.ok(r.noNode);
    assert.strictEqual(r.guard.hadCards, true); assert.strictEqual(r.guard.lastCount, 3); assert.strictEqual(r.guardCleared.hadCards, false);
    assert.strictEqual(r.iconBad, 'error:invalid'); assert.strictEqual(r.iconOk, 'ok'); assert.strictEqual(r.icon, 3);
    assert.ok(r.startup, '启动检查点已记录');
    assert.strictEqual(r.ev.message, '[local-path] Bearer [secret] [secret] [network-endpoint] [email]');
    assert.ok(r.rep.free > 0); assert.strictEqual(r.rep.pickers.systemFile, true); assert.strictEqual(r.rep.safety.configured, false);
    assert.strictEqual(r.rep.appVersion, parseGradle(fs.readFileSync(path.join(DESKTOP, '..', 'app', 'build.gradle.kts'), 'utf8')).name, '版本号与 Android 一致');
    assert.deepStrictEqual(await app.evaluate(() => global.__kakuOpened), ['https://example.com/a?b=1']);
    await waitToast(/无法打开链接/);
  });

  await step('AndroidDL.beginSelectedStage：系统对话框选中的文件由原生后台复制，可轮询、分块读回', async () => {
    const f = path.join(D.fixtures, '青岚.png');
    await pe(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'e2eInput'; i.style.display = 'none'; document.body.appendChild(i); });
    await chooseFiles('#e2eInput', f);
    const size = fs.statSync(f).size;
    const job = await pe(([n, s]) => AndroidDL.beginSelectedStage(n, s, 'e2e_task', 'fa'), ['青岚.png', size]);
    assert.match(job, /^copy_\d+_\d+$/);
    await waitPage((j) => JSON.parse(AndroidDL.stageCopyStatus(j)).state === 'done', job);
    assert.strictEqual(await pe(() => AndroidDL.beginSelectedStage('青岚.png', 1, 't', 'x')), '', '一次性：用过或大小不符就不能再用');
    assert.strictEqual(JSON.parse(await pe(() => AndroidDL.stageCopyStatus('nope'))).state, 'missing');
    const b64 = await pe(() => AndroidDL.readStageChunk('e2e_task', 'fa', 0, 512 * 1024));
    assert.ok(Buffer.from(b64, 'base64').equals(fs.readFileSync(f)));
    assert.strictEqual(await pe((s) => AndroidDL.stageFileSize('e2e_task', 'fa') === s, size), true);
    await pe(() => AndroidDL.clearStage('e2e_task'));
    assert.ok(!fs.existsSync(path.join(D.userData, 'files', 'transfer_staging', 'e2e_task')));
  });

  await step('导入：系统对话框选择 2 张 PNG + 1 个 ZIP（原生暂存、ZIP 分批解压、安全规则）', async () => {
    await pe(() => openImport());
    await chooseFiles('#fileInput', ['青岚.png', '白夜.png', '角色包.zip'].map((n) => path.join(D.fixtures, n)));
    await waitPage(() => !importStageBusy && pendFiles.length === 3);
    const staged = fs.readdirSync(path.join(D.userData, 'files', 'transfer_staging'));
    assert.strictEqual(staged.length, 1, '一个导入任务的暂存目录');
    await pe(() => startImport());
    await waitPage(() => pendingImportReview && pendingImportReview.items.length === 6, null, 60000);
    const names = await pe(() => pendingImportReview.items.map((x) => x.card.name).sort());
    assert.deepStrictEqual(names, ['ZIP丙', 'ZIP乙', 'ZIP甲', 'ZIP逃逸', '白夜', '青岚'].sort());
    assert.ok(!fs.existsSync(path.join(D.userData, 'files', '逃逸.png')) && !fs.existsSync(path.join(ROOT, '逃逸.png')), 'ZIP 条目名不会变成路径');
    await pe(() => confirmImportReview());
    await waitPage(() => S.cards.filter((c) => !c._delAt).length === 6, null, 60000);
  });

  let backupFile;
  await step('导出：单张原文件（saveBase64）、完整备份（beginFile 分块）、ZIP 打包（beginZip）', async () => {
    const id = await pe(() => S.cards.find((c) => c.name === '青岚').id);
    await pe((id) => exportCard(id, 'orig'), id);
    const png = await waitFile(D.downloads, /^青岚.*\.png$/);
    assert.strictEqual(readChara(fs.readFileSync(png)).data.name, '青岚');
    await waitToast(/已保存：.*青岚/);
    await pe(() => exportAllData());
    backupFile = await waitFile(D.downloads, /^卡库备份_.*\.json$/, 60000);
    await sleep(500);
    const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    assert.strictEqual(backup.cards.length, 6);
    await pe(async () => { const t = await createTransferTask('zip', 'E2E', S.cards.map((c) => c.id), { baseName: 'E2E全部' }); await executeTransferTask(t); });
    const zip = await waitFile(D.downloads, /^E2E全部_第1部分_6项\.zip$/, 60000);
    const entries = [];
    await walkEntries(zip, (e) => { entries.push(e.name); return true; });
    assert.strictEqual(entries.length, 6);
    assert.ok(entries.every((n) => /\.png$/.test(n)));
    assert.deepStrictEqual(fs.readdirSync(D.downloads).filter((n) => n.endsWith('.part')), [], '没有残留 .part');
  });

  await step('恢复备份：清空卡库后用备份文件恢复（restoreInput → 原生暂存 → 分块读回）', async () => {
    await pe(() => clearAllData(false));
    await waitPage(() => S.cards.length === 0);
    await chooseFiles('#restoreInput', backupFile);
    await waitPage(() => S.cards.filter((c) => !c._delAt).length === 6, null, 60000);
    assert.ok(await pe(() => S.cards.some((c) => c.name === 'ZIP乙')));
  });

  await step('文件夹扫描：文件夹对话框 → 递归扫描 → 导入', async () => {
    await nextDir(D.scan);
    await pe(() => chooseScanFolder());
    await waitPage(() => getScanFolders().length === 1);
    const f = await pe(() => getScanFolders()[0]);
    assert.strictEqual(f.name, D.scan);
    assert.ok(f.uri.startsWith('file://'));
    await pe(() => scanAllFolders());
    await waitPage(() => pendFiles.length === 2);
    assert.deepStrictEqual(await pe(() => pendFiles.map((x) => x.name).sort()), ['子目录/扫描二.png', '扫描一.png']);
    await pe(() => startImport());
    await waitPage(() => pendingImportReview && pendingImportReview.items.length === 2);
    await pe(() => confirmImportReview());
    await waitPage(() => S.cards.filter((c) => !c._delAt).length === 8);
    assert.ok(!fs.existsSync(path.join(D.userData, 'cache', 'folder_scan')) || fs.readdirSync(path.join(D.userData, 'cache', 'folder_scan')).length === 0, '扫描副本已清理');
  });

  await step('酒馆 HTTP：Basic 认证 + cookie/CSRF、推送角色卡、拉取列表与大图（>4MB 落盘分块）', async () => {
    await pe((u) => { localStorage.setItem('stAuth', JSON.stringify({ mode: 'basic', user: 'kaku', password: 'p@ss:word' })); stUrl = u; _stCsrf = ''; }, st.url);
    // 没带认证 → 401；错误 CSRF → 403
    const raw401 = await pe((u) => { StHttpBridge.setBasicAuth(u, '', ''); return JSON.parse(StHttpBridge.get(u + '/csrf-token', '')).status; }, st.url);
    assert.strictEqual(raw401, 401);
    await pe(() => testStConnection());
    await waitPage(() => /连接成功/.test(document.getElementById('stStatus').textContent));
    const csrfReq = st.log.filter((x) => x.path === '/csrf-token').pop();
    assert.ok(csrfReq.auth.startsWith('Basic '));
    const bad = await pe((u) => JSON.parse(StHttpBridge.post(u + '/api/characters/all', 'wrong-token', '{}')).status, st.url);
    assert.strictEqual(bad, 403);
    // 设了 Basic 认证时不自动跟随重定向（与 Java 相同，避免把密码带到别的地址）
    const moved = await pe((u) => JSON.parse(StHttpBridge.get(u + '/moved', '')).status, st.url);
    assert.strictEqual(moved, 302);
    // 推送
    const id = await pe(() => S.cards.find((c) => c.name === '白夜').id);
    const pushed = await pe((id) => uploadCardToTavern(id), id);
    assert.strictEqual(pushed, '白夜');
    const imp = st.log.filter((x) => x.path === '/api/characters/import').pop();
    assert.strictEqual(imp.status, 200);
    assert.ok(imp.csrf && imp.cookie.includes('session-e2e.sig='), '带了 CSRF 和签名 cookie');
    assert.ok(fs.existsSync(path.join(D.remoteChars, '白夜.png')));
    // 拉取列表（fetchCharListLite）
    await pe(() => pullFromTavern());
    await waitPage(() => Array.isArray(_stPullList) && _stPullList.length === 3 && document.getElementById('stPullModal').classList.contains('show'));
    const list = await pe(() => _stPullList.map((x) => x.name + ':' + x.status).sort());
    assert.deepStrictEqual(list, ['白夜:local', '超大远端:new', '酒馆远端:new']);
    await pe(() => { document.querySelectorAll('.stp-cb').forEach((cb) => { cb.checked = _stPullList[parseInt(cb.dataset.idx)].status === 'new'; }); });
    await pe(() => executeStPull());
    await waitPage(() => S.cards.some((c) => c.name === '超大远端') && S.cards.some((c) => c.name === '酒馆远端'), null, 60000);
    const big = await pe(async () => { const c = await dbG('cards', S.cards.find((x) => x.name === '超大远端').id); return { fileSize: c.fileSize, raw: String(c.rawData || '').length }; });
    const bigReq = st.log.filter((x) => x.path.startsWith('/characters/') && decodeURIComponent(x.path).includes('超大远端')).pop();
    assert.strictEqual(bigReq && bigReq.status, 200);
    assert.ok(big.raw > 5 * 1024 * 1024 * 4 / 3, '大图完整读回：' + JSON.stringify(big));
    assert.deepStrictEqual(fs.readdirSync(path.join(D.userData, 'cache')).filter((n) => /^st_/.test(n)), [], '大响应临时文件已删除');
    // 页面目前没用到、但照 Java 保留的分块上传与 multipart 上传
    const up = await pe(async (u) => {
      const card = await dbG('cards', S.cards.find((c) => c.name === '青岚').id);
      const b64 = String(card.rawData).split(',')[1];
      StHttpBridge.uploadBegin();
      const half = Math.floor(b64.length / 8) * 4;
      const a1 = StHttpBridge.uploadAppend(b64.slice(0, half)), a2 = StHttpBridge.uploadAppend(b64.slice(half));
      const r1 = JSON.parse(StHttpBridge.uploadCommit(u + '/api/characters/import', _stCsrf, 'up.png'));
      const r2 = JSON.parse(StHttpBridge.postMultipart(u + '/api/characters/import', _stCsrf, 'pm.png', b64));
      return { a1, a2, s1: r1.status, b1: _stUtf8(atob(r1.b64)), s2: r2.status, bad: StHttpBridge.uploadAppend(null) };
    }, st.url);
    assert.match(up.a1, /^OK:\d+$/); assert.match(up.a2, /^OK:\d+$/);
    assert.strictEqual(up.s1, 200); assert.strictEqual(JSON.parse(up.b1).file_name, '青岚'); assert.strictEqual(up.s2, 200);
    assert.deepStrictEqual(st.log.filter((x) => x.importFile).slice(-2).map((x) => x.importFile), ['up.png', 'pm.png']);
    // readSpillChunk 不能读任意路径
    const evil = await pe(() => JSON.parse(StHttpBridge.readSpillChunk(btoa('/etc/passwd'), 0, 100)).n);
    assert.strictEqual(evil, -1);
  });

  const POINT = 'tfp_e2e_cards';
  await step('酒馆文件夹存档点：授权 → 扫描对比 → 双向同步（读文件导入、写文件到 characters）', async () => {
    await pe((id) => { tavernPoints = loadTavernPoints(); tavernPoints.push({ id, name: 'E2E角色卡', section: tavernRoleSection(), kind: 'cards' }); saveTavernPoints(); }, POINT);
    await nextDir(path.dirname(D.st)); // 选 data 目录，应自动找到 data/default-user/characters
    await pe((id) => chooseTavernPointFolder(id), POINT);
    await waitPage((id) => { const f = JSON.parse(AndroidFolder.getTavernFolder(id, 'cards')); return f.ready === true; }, POINT);
    const info = await pe((id) => JSON.parse(AndroidFolder.getTavernFolder(id, 'cards')), POINT);
    assert.strictEqual(info.target, 'characters');
    await pe((id) => scanTavernFolderCompare(id), POINT);
    await waitPage(() => Array.isArray(tfRows) && tfRows.length > 0 && document.getElementById('tavernFolderModal').classList.contains('show'));
    const rows = await pe(() => tfRows.map((r) => r.name + ':' + r.state));
    assert.ok(rows.includes('目录远端:remote'));
    assert.ok(rows.includes('青岚:local'));
    await pe(() => { for (const r of tfRows) r.checked = r.name === '目录远端' || r.name === '青岚'; });
    await pe(() => executeTavernFolderSync());
    await waitPage(() => S.cards.some((c) => c.name === '目录远端'), null, 60000);
    const written = await waitFile(path.join(D.st, 'characters'), /^青岚\.png$/);
    assert.strictEqual(readChara(fs.readFileSync(written)).data.name, '青岚');
    assert.deepStrictEqual(fs.readdirSync(path.join(D.st, 'characters')).filter((n) => n.includes('kaku-tmp')), []);
    // 越权读取被拒
    assert.strictEqual(await pe((u) => AndroidFolder.readTavernChunk(u, 0, 100), 'file:///etc/passwd'), '');
    assert.strictEqual(await pe((id) => AndroidFolder.beginTavernWrite(id, 'cards', '青岚.png', false), POINT), 'exists');
  });

  const UPOINT = 'tfp_e2e_user';
  await step('User 设定：扫描 settings.json → 导入 → 写回新头像与设定（异步回调、备份、只改两个字段）', async () => {
    await pe((id) => { tavernPoints.push({ id, name: 'E2E用户', section: 'User设定', kind: 'section' }); saveTavernPoints(); }, UPOINT);
    await nextDir(D.st);
    await pe((id) => chooseTavernPointFolder(id), UPOINT);
    await waitPage((id) => !!JSON.parse(AndroidFolder.getTavernFolder(id, 'section')).uri, UPOINT);
    const before = fs.readFileSync(path.join(D.st, 'settings.json'), 'utf8');
    await pe((id) => scanTavernFolderCompare(id), UPOINT);
    await waitPage(() => Array.isArray(tfRows) && tfRows.some((r) => r.key === 'user-default.png'));
    await pe(() => { for (const r of tfRows) r.checked = r.key === 'user-default.png'; });
    await pe(() => personaSync());
    await waitPage(() => S.cards.some((c) => c.section === 'User设定' && c.name === '旅人'), null, 60000);
    // 新建一张只有卡库有的 User 设定，写回酒馆
    await pe(async (id) => {
      const src = await dbG('cards', S.cards.find((c) => c.name === '旅人').id);
      const card = { ...src, id: 'c_e2e_persona', name: '新角色身份', description: '卡库里新写的身份', personaKey: 'custom-e2e.png', personaPointId: id, importedAt: Date.now() };
      await dbP('cards', card); S.cards.push(lighten(card));
      window.__stages = []; const orig = window.onPersonaNativeStage; window.onPersonaNativeStage = (s) => { window.__stages.push(s); orig(s); };
    }, UPOINT);
    await pe((id) => scanTavernFolderCompare(id), UPOINT);
    await waitPage(() => Array.isArray(tfRows) && tfRows.some((r) => r.state === 'local'));
    await pe(() => { for (const r of tfRows) r.checked = r.state === 'local'; });
    await pe(() => personaSync());
    const t0 = Date.now();
    let after;
    for (;;) { after = fs.readFileSync(path.join(D.st, 'settings.json'), 'utf8'); if (after.includes('新角色身份') || Date.now() - t0 > 30000) break; await sleep(200); }
    const parsed = JSON.parse(after);
    const key = Object.keys(parsed.power_user.personas).find((k) => parsed.power_user.personas[k] === '新角色身份');
    assert.match(key, /^kaku_persona_[A-Za-z0-9_-]+\.png$/);
    assert.strictEqual(parsed.power_user.persona_descriptions[key].description, '卡库里新写的身份');
    assert.ok(fs.existsSync(path.join(D.st, 'User Avatars', key)), '新头像已写入');
    assert.ok(after.includes('"big_number": 12345678901234567890'), '其他内容逐字保留');
    assert.ok(after.includes('"extension_settings": {\n        "note": "保持不变"\n    }'));
    const backups = fs.readdirSync(D.st).filter((n) => /^settings\.persona-backup-.*\.json$/.test(n));
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(D.st, backups[0]), 'utf8'), before, '备份是写回前的原文件');
    assert.deepStrictEqual(fs.readdirSync(D.st).filter((n) => n.includes('persona-stage')), [], '暂存文件已删除');
    const stages = await pe(() => window.__stages);
    assert.ok(stages.includes('正在写回并核验结果，请勿关闭…'), '收到原生进度回调');
    // 设置被外部改动时拒绝写回
    const stale = await pe((id) => JSON.parse(AndroidFolder.commitPersonaSettings(id, 'deadbeef', '[]')).error, UPOINT);
    assert.match(stale, /设置已变化/);
    assert.strictEqual(await pe((id) => AndroidFolder.rollbackPersonaAvatar(id, '../settings.json'), UPOINT), 'error:文件名无效');
  });

  await step('实时备份（安全库）：授权目录 → 补齐写入 → 清空卡库 → 从备份恢复', async () => {
    await nextDir(D.safety);
    await pe(() => chooseSafetyLibrary());
    await waitPage(() => JSON.parse(AndroidFolder.safetyInfo()).ready === true);
    await pe(() => { safetyInfoCache = null; });
    const total = await cardCount();
    await pe(() => mirrorExistingCards());
    const t0 = Date.now();
    let files;
    for (;;) {
      files = fs.readdirSync(D.safety);
      const originals = files.filter((n) => /^kaku_.+__.+\.(png|json)$/.test(n) && !n.includes('.pending_'));
      if (originals.length >= total && !(await pe(() => safetyMirrorRunning || safetyManualRunning))) break;
      if (Date.now() - t0 > 90000) throw new Error('实时备份超时：' + originals.length + '/' + total);
      await sleep(300);
    }
    const metas = files.filter((n) => /^kaku_meta_.+\.json$/.test(n));
    assert.strictEqual(metas.length, total);
    assert.deepStrictEqual(files.filter((n) => n.includes('.pending_') || n.includes('.previous_')), [], '没有残留暂存/旧版本');
    const env = await pe(() => JSON.parse(AndroidDiagnosis.environmentReport()).safety);
    assert.strictEqual(env.configured, true); assert.strictEqual(env.readable, true); assert.strictEqual(env.directoryFileCount, total * 2);
    await pe(() => clearAllData(false));
    await waitPage(() => S.cards.length === 0);
    assert.strictEqual(fs.readdirSync(D.safety).length, total * 2, '仅清空卡库时备份保留');
    await pe(() => restoreFromSafetyLibrary());
    await waitPage((n) => S.cards.filter((c) => !c._delAt).length === n, total, 90000);
    assert.ok(await pe(() => S.cards.some((c) => c.name === '超大远端')));
  });

  await step('WebDAV（坚果云）：页面直接 fetch 第三方服务，不受 CORS / 混合内容拦截', async () => {
    await pe(([u]) => { webdavConfig.url = u + '/dav/'; webdavConfig.user = 'kaku@example.com'; webdavConfig.pass = 'app-pass'; }, [dav.url]);
    await pe(() => testWebdav());
    await waitPage(() => /连接成功|连接失败|网络或跨域错误/.test(document.getElementById('toast').textContent), null, 20000);
    const t1 = await pe(() => document.getElementById('toast').textContent);
    assert.match(t1, /连接成功/, '测试连接：' + t1);
    const total = await cardCount();
    await pe(() => syncPush());
    // 新版同步会读取响应头 ETag、发送 If-Match / If-None-Match，都需要跨域放行
    await waitPage(() => /云端已确认|上传完成|同步失败/.test(document.getElementById('toast').textContent), null, 60000);
    const t2 = await pe(() => document.getElementById('toast').textContent);
    assert.match(t2, new RegExp('云端已确认 ' + total + ' 项，失败/冲突 0 项'), '推送：' + t2);
    const index = JSON.parse(dav.files.get('/dav/KakuSync/Index.json').toString('utf8'));
    assert.strictEqual(Object.keys(index.fileMap).length, total);
    await pe(() => syncPull());
    await waitPage((n) => Array.isArray(_wdPullList) && _wdPullList.length === n, total, 30000);
    assert.ok(dav.log.some((x) => x.method === 'PROPFIND' && x.auth));
    assert.ok(dav.log.filter((x) => x.method === 'PUT').length >= total + 1);
    assert.ok(dav.log.some((x) => x.method === 'OPTIONS' && !x.auth), '服务器对预检返回 401 时仍能继续');
    assert.ok(dav.log.every((x) => x.origin === 'kaku://app'));
  });

  await step('AndroidAI：postAsync/getAsync 后台请求，结果经 onAIHttpResult 回调', async () => {
    const reply = await pe((u) => aiNativeAsync('POST', u + '/v1/chat/completions', 'sk-e2e-key', JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: '你好' }] })), ai.url);
    assert.strictEqual(JSON.parse(reply).choices[0].message.content, '模拟回复：收到');
    const models = await pe((u) => aiNativeAsync('GET', u + '/v1/models', 'sk-e2e-key'), ai.url);
    assert.strictEqual(JSON.parse(models).data[0].id, 'mock-model');
    const redirected = await pe((u) => aiNativeAsync('GET', u + '/redirect', 'sk-e2e-key'), ai.url);
    assert.strictEqual(JSON.parse(redirected).data[0].id, 'mock-model', '普通请求跟随重定向');
    const bad = await pe((u) => aiNativeAsync('POST', u + '/v1/chat/completions', 'wrong', '{}').then(() => 'ok', (e) => e.message), ai.url);
    assert.match(bad, /HTTP 401/);
    const scheme = await pe(() => JSON.parse(AndroidAI.post('file:///etc/passwd', '', '{}')));
    assert.strictEqual(scheme.status, -1);
    assert.strictEqual(ai.log.filter((x) => x.path === '/v1/chat/completions')[0].auth, 'Bearer sk-e2e-key');
  });

  await step('检查更新：读取项目 update.json，有新版时提示并打开下载页（不下载安装）', async () => {
    await app.evaluate(() => { global.__kakuBoxes = []; global.__kakuOpened = []; });
    await pe(() => AndroidDL.checkAppUpdate());
    const t0 = Date.now();
    let boxes = [], toast = '';
    for (;;) {
      boxes = await app.evaluate(() => global.__kakuBoxes);
      toast = await nativeToast();
      if (boxes.length || /当前已是最新版本|检查更新失败/.test(toast) || Date.now() - t0 > 45000) break;
      await sleep(200);
    }
    if (/检查更新失败/.test(toast)) throw new Error(toast);
    if (boxes.length) {
      assert.match(boxes[0].title, /^发现新版 /);
      await sleep(300);
      const opened = await app.evaluate(() => global.__kakuOpened);
      assert.strictEqual(opened.length, 1);
      assert.match(opened[0], /^https:\/\/github\.com\/kitten112233\/keke-card-library\/releases\//);
      console.log('    update:', boxes[0].title, '→', opened[0]);
    } else {
      assert.match(toast, /当前已是最新版本/);
    }
  });

  await step('返回键：Alt+← 逐层关闭弹窗，全部关闭后不退出', async () => {
    await pe(() => { document.querySelectorAll('.modal-mask.show').forEach((m) => m.classList.remove('show')); openModal('settingsModal'); });
    await waitPage(() => document.getElementById('settingsModal').classList.contains('show'));
    await page.keyboard.press('Alt+ArrowLeft');
    await waitPage(() => !document.querySelector('.modal-mask.show'));
    await page.keyboard.press('Alt+ArrowLeft');
    await sleep(800);
    assert.ok(!(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDestroyed())), '窗口仍在');
  });

  const label = process.env.KAKU_E2E_EXECUTABLE ? 'packaged' : 'dev';
  await page.screenshot({ path: path.join(OUT, 'final-' + label + '.png') });
  await app.close();
  st.server.close(); ai.server.close(); dav.server.close();
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, 'e2e-results-' + label + '.json'), JSON.stringify({ at: new Date().toISOString(), platform: process.platform, electron: require('electron/package.json').version, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (!failed.length) { try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { console.log('测试目录未能删除：' + ROOT); } }
  else console.log('测试目录保留：' + ROOT);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => { console.error(e); try { await app?.close(); } catch (x) { /* ignore */ } process.exit(1); });
