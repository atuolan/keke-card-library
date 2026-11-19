'use strict';
// 克克卡库 Windows 桌面版主进程：对应 Android 端 MainActivity 的 WebView 外壳部分。
const { app, BrowserWindow, protocol, session, ipcMain, dialog, shell, Menu, nativeImage } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const U = require('./util');
const { Prefs } = require('./prefs');
const { readVersion } = require('./version');
const { createUpdater } = require('./updater');
const { createDownloadBridge } = require('./bridges/download');
const { createStHttpBridge } = require('./bridges/sthttp');
const { createFolderBridge } = require('./bridges/folder');
const { createAiBridge, createGuardBridge, createDiagnosisBridge, createNavBridge, createPickerBridge } = require('./bridges/small');

const SCHEME = 'kaku';
const ORIGIN = 'kaku://app';
const START_URL = ORIGIN + '/index.html';

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

// 应用私有目录：%APPDATA%\KaKu（固定英文名，避免中文路径兼容问题）。测试时可用环境变量覆盖。
app.setPath('userData', process.env.KAKU_USER_DATA_DIR || path.join(app.getPath('appData'), 'KaKu'));

const assetsDir = () => process.env.KAKU_ASSETS_DIR ||
  (app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets'));

let mainWindow = null;
let forceClose = false;
const ctx = {
  isPackaged: app.isPackaged,
  busy: new Set(),
  selectedFiles: new Map(),
  sessions: {},
};
let bridges = null;
let parts = null;

function initContext() {
  const userData = app.getPath('userData');
  ctx.paths = {
    userData,
    files: path.join(userData, 'files'),
    cache: path.join(userData, 'cache'),
    prefs: path.join(userData, 'prefs'),
    downloads: process.env.KAKU_DOWNLOADS_DIR || path.join(app.getPath('downloads'), '卡库'),
    assets: assetsDir(),
  };
  for (const d of [ctx.paths.files, ctx.paths.cache]) fs.mkdirSync(d, { recursive: true });
  ctx.prefs = new Prefs(ctx.paths.prefs);
  ctx.version = readVersion();
  // 与 Java 一样使用内存 cookie：重启后需要重新登录酒馆
  ctx.sessions.st = session.fromPartition('kaku-st-http');
  ctx.sessions.ai = session.fromPartition('kaku-ai-http');
  ctx.sessions.update = session.fromPartition('kaku-update');
  ctx.toast = (msg) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('kaku:toast', String(msg)); };
  ctx.evalInPage = (code) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.executeJavaScript(code).catch(() => {});
  };
  ctx.chooseDirectory = async (title) => {
    const r = await dialog.showOpenDialog(mainWindow, { title, properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  };
  ctx.showMessageBox = (opts) => dialog.showMessageBox(mainWindow, opts);
  ctx.setWindowIcon = (img) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(img); };
  ctx.closeWindow = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); };
  ctx.updater = createUpdater(ctx);

  parts = {
    AndroidDL: createDownloadBridge(ctx),
    StHttpBridge: createStHttpBridge(ctx),
    AndroidFolder: createFolderBridge(ctx),
    AndroidAI: createAiBridge(ctx),
    AndroidGuard: createGuardBridge(ctx),
    AndroidDiagnosis: createDiagnosisBridge(ctx),
    AndroidNav: createNavBridge(ctx),
    AndroidPicker: createPickerBridge(ctx),
  };
  bridges = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.methods]));
}

async function cleanStartupCache() {
  // Android 的 cacheDir 会被系统回收；桌面版启动时清掉上次遗留的扫描副本和大响应临时文件。
  // transfer_staging（可续传的导入/恢复暂存）保留。
  await U.rmrf(path.join(ctx.paths.cache, 'folder_scan'));
  try {
    for (const n of await fsp.readdir(ctx.paths.cache)) if (/^st_(resp|list)_.*\.tmp$/.test(n)) await fsp.rm(path.join(ctx.paths.cache, n), { force: true });
  } catch (e) { /* ignore */ }
}

function isTrustedSender(event) {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame && String(event.senderFrame.url || '').startsWith(ORIGIN + '/');
}

function registerIpc() {
  // 页面调用 window.AndroidXxx.method(...) → preload ipcRenderer.sendSync → 这里。
  // 处理函数可以是异步的：renderer 会一直等到 returnValue 设置，保持 Java 桥的同步语义。
  ipcMain.on('kaku:bridge', (event, bridge, method, args) => {
    const reply = (v) => { try { event.returnValue = v; } catch (e) { /* 窗口已关闭 */ } };
    if (!isTrustedSender(event)) { reply({ e: 'forbidden' }); return; }
    const b = bridges[bridge];
    if (!b || !Object.prototype.hasOwnProperty.call(b, method) || typeof b[method] !== 'function') { reply({ e: 'Method not found: ' + bridge + '.' + method }); return; }
    Promise.resolve()
      .then(() => b[method](...(Array.isArray(args) ? args : [])))
      .then((v) => reply(v === undefined ? { u: 1 } : { v }), (e) => reply({ e: U.errMsg(e) }));
  });
  // preload 记录用户在系统文件对话框或拖放中选中的文件，供 beginSelectedStage 原生复制（对应 Java selectedFileUris）
  ipcMain.on('kaku:files-selected', (event, rows) => {
    if (!isTrustedSender(event)) { event.returnValue = false; return; }
    if (Array.isArray(rows)) {
      for (const r of rows.slice(0, 5000)) {
        if (!r || typeof r.path !== 'string' || !path.isAbsolute(r.path) || typeof r.name !== 'string') continue;
        const key = r.name + '\n' + Math.trunc(Number(r.size) || 0);
        ctx.selectedFiles.delete(key);
        ctx.selectedFiles.set(key, r.path);
      }
      while (ctx.selectedFiles.size > 5000) ctx.selectedFiles.delete(ctx.selectedFiles.keys().next().value);
    }
    event.returnValue = true;
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function registerProtocol() {
  protocol.handle(SCHEME, async (request) => {
    try {
      const u = new URL(request.url);
      if (u.host !== 'app') return new Response('Not found', { status: 404 });
      let rel = decodeURIComponent(u.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const root = path.resolve(ctx.paths.assets);
      const file = path.resolve(root, '.' + rel);
      if (!file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
      const st = await fsp.stat(file);
      if (!st.isFile()) return new Response('Not found', { status: 404 });
      const body = await fsp.readFile(file);
      return new Response(body, { status: 200, headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });
}

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') shell.openExternal(u.href).catch(() => {});
  } catch (e) { /* ignore */ }
}

function setupSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen', 'persistent-storage']);
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((wc, permission) => allowed.has(permission));
  // 页面里少数“浏览器式下载”（<a download>）也直接存到 下载\卡库，不弹对话框
  ses.on('will-download', (event, item) => {
    try {
      fs.mkdirSync(ctx.paths.downloads, { recursive: true });
      const name = U.safeFileName(item.getFilename() || 'download.bin', 'download.bin');
      const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
      let target = path.join(ctx.paths.downloads, name);
      for (let i = 1; fs.existsSync(target); i++) target = path.join(ctx.paths.downloads, `${base} (${i})${ext}`);
      item.setSavePath(target);
      item.once('done', (e, state) => ctx.toast(state === 'completed' ? '已保存：' + target : '保存失败：' + state));
    } catch (e) { item.cancel(); }
  });
}

function windowIcon() {
  const n = U.toInt(ctx.prefs.get('appearance', 'launcherIcon', 2)) || 2;
  const img = nativeImage.createFromPath(path.join(ctx.paths.assets, 'icons', 'icon_' + n + '.png'));
  return img.isEmpty() ? undefined : img;
}

function isBusy() {
  return parts.AndroidDL.isBusy() || parts.AndroidFolder.isBusy() || ctx.busy.size > 0;
}

function createWindow() {
  const saved = ctx.prefs.all('window');
  mainWindow = new BrowserWindow({
    width: Number(saved.width) || 1280,
    height: Number(saved.height) || 860,
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined,
    minWidth: 360,
    minHeight: 520,
    show: false,
    backgroundColor: '#ffffff',
    title: '克克卡库',
    icon: windowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      backgroundThrottling: false,
      webviewTag: false,
    },
  });
  if (saved.maximized) mainWindow.maximize();
  Menu.setApplicationMenu(null);
  const wc = mainWindow.webContents;

  wc.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN + '/')) { e.preventDefault(); openExternalSafe(url); } });
  wc.on('will-redirect', (e, url) => { if (!url.startsWith(ORIGIN + '/')) e.preventDefault(); });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = String(input.key || '');
    const mod = input.control || input.meta;
    if (k === 'F12' || (mod && input.shift && k.toLowerCase() === 'i')) { wc.toggleDevTools(); e.preventDefault(); }
    else if (mod && (k === '=' || k === '+')) { wc.setZoomLevel(Math.min(5, wc.getZoomLevel() + 0.5)); e.preventDefault(); }
    else if (mod && k === '-') { wc.setZoomLevel(Math.max(-3, wc.getZoomLevel() - 0.5)); e.preventDefault(); }
    else if (mod && k === '0') { wc.setZoomLevel(0); e.preventDefault(); }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => {
    try {
      const b = mainWindow.getNormalBounds();
      ctx.prefs.edit('window', (o) => { o.width = b.width; o.height = b.height; o.x = b.x; o.y = b.y; o.maximized = mainWindow.isMaximized(); });
    } catch (x) { /* ignore */ }
    if (forceClose || !isBusy()) return;
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', title: '克克卡库', buttons: ['继续等待', '仍然关闭'], defaultId: 0, cancelId: 0, noLink: true,
      message: '还有文件正在写入或复制',
      detail: '现在关闭可能留下不完整的文件（导出、暂存、酒馆写回或实时备份）。建议等待完成后再关闭。',
    });
    if (r === 0) e.preventDefault();
    else forceClose = true;
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(START_URL);
}

if (process.platform === 'win32') app.setAppUserModelId('com.operit.webviewapp.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(async () => {
    initContext();
    await cleanStartupCache();
    registerProtocol();
    registerIpc();
    setupSession();
    app.on('login', (event, wc, details, authInfo, cb) => { event.preventDefault(); cb(); });
    createWindow();
  });
  app.on('before-quit', async () => { try { await parts?.AndroidFolder.cleanup(); } catch (e) { /* ignore */ } });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { ctx };
