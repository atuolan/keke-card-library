'use strict';
// 在页面中暴露与 Android addJavascriptInterface 同名、同签名的 8 个桥。
// 每个方法都用 ipcRenderer.sendSync，保持 Java @JavascriptInterface 的同步调用语义。
// 运行在 sandbox + contextIsolation 下：页面拿不到 ipcRenderer，也拿不到任何 Node API。
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

const BRIDGES = {
  AndroidDL: ['checkAppUpdate', 'beginSelectedStage', 'stageCopyStatus', 'listZipEntries', 'extractZipEntry', 'extractZipBatch',
    'deleteStageFile', 'stageFileSize', 'beginFile', 'appendChunk', 'endFile', 'abortFile', 'beginZip', 'beginZipEntry',
    'appendZipChunk', 'endZipEntry', 'finishZip', 'abortZip', 'beginStage', 'appendStageChunk', 'endStage', 'readStageChunk',
    'clearStage', 'saveBase64'],
  StHttpBridge: ['setBasicAuth', 'get', 'post', 'put', 'del', 'readSpillChunk', 'deleteSpill', 'fetchCharListLite',
    'uploadBegin', 'uploadAppend', 'uploadCommit', 'postMultipart', 'postRaw'],
  AndroidFolder: ['getLauncherIcon', 'setLauncherIcon', 'chooseTavernFolder', 'getTavernFolder', 'clearTavernFolder',
    'readPersonaSettings', 'commitPersonaSettingsAsync', 'commitPersonaSettings', 'rollbackPersonaAvatar', 'scanTavernFolder',
    'readTavernChunk', 'beginTavernWrite', 'appendTavernChunk', 'endTavernWrite', 'chooseSafetyFolder', 'disableSafetyFolder',
    'safetyInfo', 'beginSafetyBatch', 'endSafetyBatch', 'hasSafetyPair', 'commitSafetyRevision', 'beginSafetyWrite',
    'beginSafetyWriteMode', 'deleteSafetyCard', 'deleteSafetyCards', 'findSafetyIdByHash', 'readSafetyMeta', 'deleteSafetyMeta',
    'cleanupSafetyMetadata', 'appendSafetyChunk', 'endSafetyWrite', 'safetyFolderUri', 'chooseFolder', 'listFolders',
    'removeFolder', 'indexSafetyRestore', 'beginSafetyRead', 'nextSafetyReadChunk', 'endSafetyRead', 'readSafetyChunk',
    'scanSafetyFolder', 'scanFolder', 'readChunk', 'clearScan'],
  AndroidAI: ['get', 'post', 'getAsync', 'postAsync'],
  AndroidGuard: ['hadCards', 'markCards', 'clearCards', 'updateCardCount', 'status'],
  AndroidDiagnosis: ['record', 'clearLogs', 'startupCheckpoint', 'environmentReport'],
  AndroidNav: ['openUrl', 'exitApp'],
  AndroidPicker: ['setMultiple', 'setMode'],
};

// “返回”只用来逐层关闭弹窗；全部关闭后不退出（桌面版用窗口关闭按钮退出）。
let suppressExitUntil = 0;

function call(bridge, method, args) {
  if (bridge === 'AndroidNav' && method === 'exitApp' && Date.now() < suppressExitUntil) return undefined;
  const r = ipcRenderer.sendSync('kaku:bridge', bridge, method, args);
  if (!r) throw new Error('bridge unavailable');
  if (Object.prototype.hasOwnProperty.call(r, 'e')) throw new Error(r.e);
  return r.u ? undefined : r.v;
}

for (const [bridge, methods] of Object.entries(BRIDGES)) {
  const api = {};
  for (const m of methods) api[m] = (...args) => call(bridge, m, args);
  contextBridge.exposeInMainWorld(bridge, api);
}

// —— 记录用户亲自选中/拖入的文件路径，供 AndroidDL.beginSelectedStage 原生复制 ——
function reportFiles(list) {
  try {
    const rows = [];
    for (const f of Array.from(list || [])) {
      let p = '';
      try { p = webUtils.getPathForFile(f); } catch (e) { p = ''; }
      if (p) rows.push({ name: f.name, size: f.size, path: p });
    }
    if (rows.length) ipcRenderer.sendSync('kaku:files-selected', rows);
  } catch (e) { /* ignore */ }
}
window.addEventListener('change', (e) => {
  const t = e.target;
  if (t && t.tagName === 'INPUT' && String(t.type).toLowerCase() === 'file' && t.files) reportFiles(t.files);
}, true);
window.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) reportFiles(e.dataTransfer.files); }, true);

// —— Android 返回键 → 鼠标侧键“后退” / Alt+← ——
function nativeBack() {
  suppressExitUntil = Date.now() + 800;
  webFrame.executeJavaScript("typeof window._handleNativeBack==='function'?window._handleNativeBack():null").catch(() => {});
}
window.addEventListener('mouseup', (e) => { if (e.button === 3) { e.preventDefault(); nativeBack(); } }, true);
window.addEventListener('keydown', (e) => { if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); nativeBack(); } }, true);

// —— Android Toast 的替代：独立浮层，不依赖页面自己的 showToast ——
let toastHost = null, toastBox = null, toastTimer = null;
function ensureToast() {
  if (toastHost && toastHost.isConnected) return;
  toastHost = document.createElement('div');
  toastHost.setAttribute('data-kaku-native-toast', '');
  toastHost.style.cssText = 'position:fixed;left:0;right:0;bottom:132px;display:flex;justify-content:center;pointer-events:none;z-index:2147483647';
  const root = toastHost.attachShadow({ mode: 'open' });
  toastBox = document.createElement('div');
  toastBox.style.cssText = 'max-width:min(720px,calc(100vw - 32px));padding:10px 16px;border-radius:10px;background:rgba(32,32,32,.92);color:#fff;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.25);opacity:0;transition:opacity .2s;white-space:pre-wrap;overflow-wrap:anywhere;text-align:center';
  toastBox.setAttribute('role', 'status');
  root.appendChild(toastBox);
  (document.body || document.documentElement).appendChild(toastHost);
}
ipcRenderer.on('kaku:toast', (e, text) => {
  const show = () => {
    ensureToast();
    toastBox.textContent = String(text);
    toastBox.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastBox.style.opacity = '0'; }, Math.min(8000, 2500 + String(text).length * 40));
  };
  if (document.body) show(); else window.addEventListener('DOMContentLoaded', show, { once: true });
});
