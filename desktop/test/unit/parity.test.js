'use strict';
// 确认桌面版暴露的方法与 MainActivity.java 的 @JavascriptInterface 完全一致（名称一个不多、一个不少）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { tmpdir, fakeCtx } = require('./helpers');

const JAVA = path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'main', 'java', 'com', 'operit', 'webviewapp', 'MainActivity.java');
const CLASS_TO_JS = {
  DownloadBridge: 'AndroidDL', StHttpBridge: 'StHttpBridge', FolderBridge: 'AndroidFolder', AiHttpBridge: 'AndroidAI',
  StorageGuardBridge: 'AndroidGuard', DiagnosisBridge: 'AndroidDiagnosis', NavBridge: 'AndroidNav', PickerBridge: 'AndroidPicker',
};

function javaMethods() {
  const src = fs.readFileSync(JAVA, 'utf8');
  const classes = [...src.matchAll(/class\s+(\w+)/g)].map((m) => ({ name: m[1], at: m.index }));
  const out = {};
  for (const m of src.matchAll(/@JavascriptInterface\s+public\s+(?:synchronized\s+)?[\w.<>\[\]]+\s+(\w+)\s*\(/g)) {
    const owner = classes.filter((c) => c.at < m.index).pop().name;
    const js = CLASS_TO_JS[owner];
    assert.ok(js, 'unknown bridge class ' + owner);
    (out[js] = out[js] || new Set()).add(m[1]);
  }
  return out;
}

function preloadMethods() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'preload.js'), 'utf8');
  const m = /const BRIDGES = (\{[\s\S]*?\n\});/.exec(src);
  return vm.runInNewContext('(' + m[1] + ')');
}

function mainMethods() {
  const ctx = fakeCtx(tmpdir());
  const { createDownloadBridge } = require('../../src/bridges/download');
  const { createStHttpBridge } = require('../../src/bridges/sthttp');
  const { createFolderBridge } = require('../../src/bridges/folder');
  const S = require('../../src/bridges/small');
  return {
    AndroidDL: createDownloadBridge(ctx).methods,
    StHttpBridge: createStHttpBridge(ctx).methods,
    AndroidFolder: createFolderBridge(ctx).methods,
    AndroidAI: S.createAiBridge(ctx).methods,
    AndroidGuard: S.createGuardBridge(ctx).methods,
    AndroidDiagnosis: S.createDiagnosisBridge(ctx).methods,
    AndroidNav: S.createNavBridge(ctx).methods,
    AndroidPicker: S.createPickerBridge(ctx).methods,
  };
}

test('8 个桥的方法名与 Java @JavascriptInterface 完全一致', () => {
  const java = javaMethods(), pre = preloadMethods(), main = mainMethods();
  assert.deepStrictEqual(Object.keys(java).sort(), Object.keys(CLASS_TO_JS).map((k) => CLASS_TO_JS[k]).sort());
  for (const [bridge, set] of Object.entries(java)) {
    const want = [...set].sort();
    assert.deepStrictEqual([...pre[bridge]].sort(), want, 'preload ' + bridge);
    assert.deepStrictEqual(Object.keys(main[bridge]).sort(), want, 'main ' + bridge);
  }
});

test('页面里调用到的每个桥方法都存在', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'main', 'assets', 'index.html'), 'utf8');
  const pre = preloadMethods();
  const missing = [];
  for (const bridge of Object.keys(pre)) {
    for (const m of html.matchAll(new RegExp('\\b' + bridge + '\\??\\.([A-Za-z_]\\w*)', 'g'))) {
      if (!pre[bridge].includes(m[1])) missing.push(bridge + '.' + m[1]);
    }
  }
  assert.deepStrictEqual([...new Set(missing)], []);
});
