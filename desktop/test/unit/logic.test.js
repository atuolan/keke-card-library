'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir, fakeCtx, buildZip } = require('./helpers');
const U = require('../../src/util');
const Z = require('../../src/zip');
const PJ = require('../../src/persona-json');
const { LiteListParser } = require('../../src/litelist');
const { createDownloadBridge } = require('../../src/bridges/download');
const { createFolderBridge } = require('../../src/bridges/folder');

test('safePart 与 Java 相同，并额外拦住 . / ..', () => {
  assert.strictEqual(U.safePart('imp_1/../x 中'), 'imp_1_.._x__');
  assert.strictEqual(U.safePart(null), 'x');
  assert.strictEqual(U.safePart('..'), '__');
  assert.strictEqual(U.safePart('.'), '_');
  assert.strictEqual(U.safePart('a.b-c_d'), 'a.b-c_d');
});

test('safeFileName 处理 Windows 非法字符、保留名和结尾的点', () => {
  assert.strictEqual(U.safeFileName('..\\..\\evil.png', 'x'), '.._.._evil.png');
  assert.strictEqual(U.safeFileName('a/b:c*?"<>|.png', 'x'), 'a_b_c______.png');
  assert.strictEqual(U.safeFileName('CON.png', 'x'), '_CON.png');
  assert.strictEqual(U.safeFileName('nul', 'x'), '_nul');
  assert.strictEqual(U.safeFileName('卡. ', 'x'), '卡__');
  assert.strictEqual(U.safeFileName('..', 'card.bin'), '__');
  assert.strictEqual(U.safeFileName('', 'card.bin'), 'card.bin');
  assert.strictEqual(U.safeFileName(null, 'file.bin'), 'file.bin');
});

test('safeZipEntry 规则与 Java 一致', () => {
  const e = (name, size, compressedSize, isDirectory = false) => ({ name, size, compressedSize, isDirectory });
  assert.ok(Z.safeZipEntry(e('a.PNG', 100, 50)));
  assert.ok(Z.safeZipEntry(e('a.jsonl', 0, 0)));
  assert.ok(!Z.safeZipEntry(e('a.exe', 100, 50)));
  assert.ok(!Z.safeZipEntry(e('dir/', 0, 0, true)));
  assert.ok(!Z.safeZipEntry(e('big.png', 32 * 1024 * 1024 + 1, 32 * 1024 * 1024)));
  assert.ok(Z.safeZipEntry(e('max.png', 32 * 1024 * 1024, 32 * 1024 * 1024)));
  assert.ok(Z.safeZipEntry(e('ratio.json', 200 * 1000, 1000)));
  assert.ok(Z.safeZipEntry(e('ratio.json', 200 * 1000 + 999, 1000))); // Java 整数除法 → 200
  assert.ok(!Z.safeZipEntry(e('bomb.json', 201 * 1000, 1000)));
  assert.ok(!Z.safeZipEntry(e('zero.json', 10, 0)));
});

test('ZIP 列表、分批解压：条目名不当路径用；GBK 文件名；超 32MB 实际字节中止', async () => {
  const root = tmpdir();
  const ctx = fakeCtx(root);
  const dl = createDownloadBridge(ctx).methods;
  const gbkName = Buffer.from([0xbd, 0xc7, 0xc9, 0xab, 0x2e, 0x70, 0x6e, 0x67]); // “角色.png” 的 GBK 编码
  const zip = buildZip([
    { name: 'ok/甲.png', data: Buffer.from('png-1'), utf8: true, deflate: true },
    { name: '../../escape.json', data: Buffer.from('{"a":1}') },
    { name: gbkName, data: Buffer.from('png-2') },
    { name: 'readme.exe', data: Buffer.from('x') },
    { name: 'folder/', data: Buffer.alloc(0) },
    { name: 'liar.json', data: Buffer.alloc(40 * 1024 * 1024, 32), deflate: true, declaredSize: 1000, declaredPacked: 500 },
  ]);
  const stageDir = path.join(ctx.paths.files, 'transfer_staging', 'task1');
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'zip1'), zip);
  const page = JSON.parse(await dl.listZipEntries('task1', 'zip1', 0, 500));
  assert.strictEqual(page.total, 4);
  assert.strictEqual(page.skipped, 1);
  assert.deepStrictEqual(page.entries.map((x) => x.name), ['ok/甲.png', '../../escape.json', '角色.png', 'liar.json']);
  const batch = JSON.parse(await dl.extractZipBatch('task1', 'zip1', 0, 2000, 64 * 1024 * 1024));
  assert.deepStrictEqual(batch.entries.map((x) => x.id), ['ze_zip1_0', 'ze_zip1_1', 'ze_zip1_2']);
  assert.strictEqual(batch.next, 4);
  assert.ok(!fs.existsSync(path.join(ctx.paths.files, 'escape.json')));
  assert.ok(!fs.existsSync(path.join(stageDir, 'ze_zip1_3')), '伪造声明大小的条目必须被删除');
  assert.strictEqual(await dl.readStageChunk('task1', 'ze_zip1_2', 0, 100), Buffer.from('png-2').toString('base64'));
  const one = JSON.parse(await dl.extractZipEntry('task1', 'zip1', 3, 'single'));
  assert.ok(one.error, '单个解压也要拦住');
  assert.strictEqual(dl.stageFileSize('task1', 'missing'), 0);
});

test('extractZipBatch 按 maxBytes 分批（Java 未使用 maxItems）', async () => {
  const ctx = fakeCtx(tmpdir());
  const dl = createDownloadBridge(ctx).methods;
  const zip = buildZip([1, 2, 3, 4].map((i) => ({ name: i + '.json', data: Buffer.alloc(100, 48 + i) })));
  const dir = path.join(ctx.paths.files, 'transfer_staging', 't');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'z'), zip);
  const b1 = JSON.parse(await dl.extractZipBatch('t', 'z', 0, 1, 250));
  assert.deepStrictEqual(b1.entries.map((x) => x.index), [0, 1]);
  assert.strictEqual(b1.next, 2);
  const b2 = JSON.parse(await dl.extractZipBatch('t', 'z', 2, 1, 1));
  assert.deepStrictEqual(b2.entries.map((x) => x.index), [2]);
  assert.strictEqual(b2.next, 3);
});

test('导出 ZIP：条目名反斜杠转斜杠、去开头斜杠，拒绝重复和 ..', async () => {
  const ctx = fakeCtx(tmpdir());
  const dl = createDownloadBridge(ctx).methods;
  assert.strictEqual(await dl.beginZip('导出.zip'), true);
  assert.strictEqual(dl.beginZipEntry('\\a\\b.png'), true);
  assert.strictEqual(await dl.appendZipChunk(Buffer.from('hello').toString('base64')), true);
  assert.strictEqual(dl.endZipEntry(), true);
  assert.strictEqual(dl.beginZipEntry('a/b.png'), false, '重复条目');
  assert.strictEqual(dl.beginZipEntry('../x.png'), false, '路径穿越条目');
  assert.strictEqual(dl.beginZipEntry('c.json'), true);
  assert.strictEqual(await dl.appendZipChunk(Buffer.from('{}').toString('base64')), true);
  assert.strictEqual(await dl.finishZip(), true);
  const out = path.join(ctx.paths.downloads, '导出.zip');
  const names = [];
  await Z.walkEntries(out, (e) => { names.push(e.name); return true; });
  assert.deepStrictEqual(names, ['a/b.png', 'c.json']);
  assert.match(ctx.toasts.pop(), /^已保存：.*导出\.zip$/);
  // 同名第二次导出不覆盖
  await dl.saveBase64(Buffer.from('x').toString('base64'), '导出.zip');
  assert.ok(fs.existsSync(path.join(ctx.paths.downloads, '导出 (1).zip')));
});

test('分块下载中途放弃不留下文件', async () => {
  const ctx = fakeCtx(tmpdir());
  const dl = createDownloadBridge(ctx).methods;
  assert.strictEqual(await dl.beginFile('备份.json'), true);
  assert.strictEqual(await dl.appendChunk(Buffer.from('{"a"').toString('base64')), true);
  await dl.abortFile();
  assert.deepStrictEqual(fs.readdirSync(ctx.paths.downloads), []);
  assert.strictEqual(await dl.appendChunk('AAAA'), false);
});

test('User 设定：只替换两个字段，其余文本逐字保留', () => {
  const raw = '{\n    "a": 1.50,\n    "power_user": {\n        "personas": {\n            "u.png": "旧"\n        },\n        "big": 12345678901234567890,\n        "persona_descriptions": {}\n    },\n    "z": "\\u4e2d"\n}\n';
  const sel = PJ.extractPersona(raw);
  assert.deepStrictEqual(sel, { power_user: { personas: { 'u.png': '旧' }, persona_descriptions: {} } });
  const patched = PJ.patchPersona(raw, { personas: { 'u.png': '旧', 'kaku_persona_1.png': '新' }, persona_descriptions: { 'kaku_persona_1.png': { description: 'd', position: 0 } } });
  assert.ok(patched.includes('"a": 1.50'));
  assert.ok(patched.includes('"big": 12345678901234567890'));
  assert.ok(patched.includes('"z": "\\u4e2d"'));
  assert.ok(patched.includes('            "kaku_persona_1.png": "新"\n        }'));
  const parsed = JSON.parse(patched);
  assert.strictEqual(parsed.power_user.persona_descriptions['kaku_persona_1.png'].description, 'd');
  assert.throws(() => PJ.patchPersona('{"x":1}', { personas: {} }), /缺少power_user/);
  const compact = PJ.patchPersona('{"power_user":{"personas":{}}}', { personas: { k: 'v' } });
  assert.strictEqual(compact, '{"power_user":{"personas":{"k":"v"}}}');
});

test('fetchCharListLite 流式解析与 Java 规则一致', () => {
  const run = (s) => { let out = ''; const p = new LiteListParser((t) => { out += t; }); const b = Buffer.from(s); for (let i = 0; i < b.length; i += 7) p.feed(b.subarray(i, i + 7)); p.finish(); return { list: JSON.parse('[' + out + ']'), count: p.count }; };
  let r = run('[{"name":"甲","avatar":"a.png","description":"' + 'x'.repeat(130) + '","data":{"name":"inner"}},5,{"name":7}]');
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.list[0].description.length, 120);
  assert.deepStrictEqual(r.list[1], { name: '', avatar: '', description: '' });
  r = run('{"x":1,"list":[{"name":"B"}],"later":[{"name":"C"}]}');
  assert.deepStrictEqual(r.list.map((x) => x.name), ['B']);
  assert.throws(() => run(''), /End of input/);
});

test('安全库：提交新版本保留旧文件直到新文件就位；删除规则与 Java 一致', async () => {
  const root = tmpdir();
  const ctx = fakeCtx(root);
  const safety = path.join(root, 'safety');
  fs.mkdirSync(safety);
  ctx.prefs.put('safety_library', 'path', safety);
  const F = createFolderBridge(ctx).methods;
  const write = async (name, text, ow) => {
    const st = await F.beginSafetyWriteMode(name, ow);
    if (st !== 'ok') return st;
    assert.strictEqual(await F.appendSafetyChunk(Buffer.from(text).toString('base64')), true);
    assert.strictEqual(await F.endSafetyWrite(), true);
    return 'ok';
  };
  assert.strictEqual(await write('kaku_c1__甲.png', 'v1', false), 'ok');
  assert.strictEqual(await write('kaku_c1__甲.png', 'v1', false), 'exists');
  assert.strictEqual(await write('kaku_meta_c1.json', '{"id":"c1","importHash":"h1","section":"卡片"}', false), 'ok');
  assert.strictEqual(await write('kaku_c1__甲.png.pending_t', 'v2', false), 'ok');
  assert.strictEqual(await write('kaku_meta_c1.json.pending_t', '{"id":"c1","importHash":"h2","section":"卡片"}', false), 'ok');
  assert.strictEqual(await F.commitSafetyRevision('kaku_c1__甲.png.pending_t', 'kaku_c1__甲.png', 'kaku_meta_c1.json.pending_t', 'kaku_meta_c1.json'), 'ok');
  assert.deepStrictEqual(fs.readdirSync(safety).sort(), ['kaku_c1__甲.png', 'kaku_meta_c1.json']);
  assert.strictEqual(fs.readFileSync(path.join(safety, 'kaku_c1__甲.png'), 'utf8'), 'v2');
  assert.strictEqual(await F.commitSafetyRevision('missing', 'kaku_c1__甲.png', 'x', 'y'), 'error:临时副本缺失，保留旧备份');
  assert.strictEqual(await F.commitSafetyRevision('../a', 'b', 'c', 'd'), 'error:无效的文件名');
  assert.strictEqual(await F.findSafetyIdByHash('h2', ''), 'c1');
  assert.strictEqual(await F.findSafetyIdByHash('h2', 'c1'), '');
  const idx = JSON.parse(await F.indexSafetyRestore());
  assert.strictEqual(idx.count, 1);
  assert.strictEqual(idx.files[0].id, 'c1');
  assert.strictEqual(idx.files[0].name, '甲.png');
  assert.strictEqual(idx.files[0].section, '卡片');
  assert.strictEqual(await F.beginSafetyRead(idx.files[0].uri), true);
  assert.strictEqual(Buffer.from(await F.nextSafetyReadChunk(1024), 'base64').toString(), 'v2');
  assert.strictEqual(await F.nextSafetyReadChunk(1024), '');
  await F.endSafetyRead();
  assert.strictEqual(await F.beginSafetyRead(U.fileUri(path.join(root, 'prefs', 'safety_library.json'))), false, '不能读安全库以外的文件');
  assert.ok(Buffer.from(await F.readSafetyMeta('c1'), 'base64').toString().includes('"h2"'));
  // 批次内 hasSafetyPair
  assert.strictEqual(F.hasSafetyPair('kaku_c1__甲.png', 'kaku_meta_c1.json'), false);
  await F.beginSafetyBatch();
  assert.strictEqual(F.hasSafetyPair('KAKU_C1__甲.png', 'kaku_meta_c1.json'), true);
  F.endSafetyBatch();
  assert.strictEqual(await F.deleteSafetyCards(JSON.stringify(['C1'])), 2);
  assert.deepStrictEqual(fs.readdirSync(safety), []);
});

test('文件夹扫描：递归、排序、跳过元数据/不支持/超大，readChunk 只读扫描副本', async () => {
  const root = tmpdir();
  const ctx = fakeCtx(root);
  const src = path.join(root, '角色卡');
  fs.mkdirSync(path.join(src, 'b子目录'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.png'), 'A');
  fs.writeFileSync(path.join(src, 'b子目录', 'c.json'), '{}');
  fs.writeFileSync(path.join(src, 'kaku_meta_x.json'), '{}');
  fs.writeFileSync(path.join(src, 'note.txt'), 't');
  fs.writeFileSync(path.join(src, 'z.png'), 'Z');
  try { fs.symlinkSync('/etc', path.join(src, 'link')); } catch (e) { /* 没权限就算了 */ }
  const uri = U.fileUri(src);
  ctx.prefs.put('folder_scan', uri, src);
  const F = createFolderBridge(ctx).methods;
  const r1 = JSON.parse(await F.scanFolder(uri, 0, 2));
  assert.deepStrictEqual(r1.files.map((f) => f.name), ['a.png', 'b子目录/c.json']);
  assert.strictEqual(r1.hasMore, true);
  assert.strictEqual(r1.stopReason, 'limit');
  assert.strictEqual(r1.nextOffset, 2);
  assert.strictEqual(r1.unsupported, 1);
  assert.deepStrictEqual(r1.skippedNames, ['note.txt']);
  assert.strictEqual(Buffer.from(await F.readChunk(r1.files[0].path, 0, 10), 'base64').toString(), 'A');
  assert.strictEqual(await F.readChunk(path.join(src, 'a.png'), 0, 10), '', '不能读原目录');
  const r2 = JSON.parse(await F.scanFolder(uri, 2, 5));
  assert.deepStrictEqual(r2.files.map((f) => f.name), ['z.png']);
  assert.strictEqual(r2.hasMore, false);
  assert.ok(JSON.parse(await F.scanFolder(U.fileUri(root), 0, 5)).error, '未授权目录不能扫描');
  assert.deepStrictEqual(JSON.parse(F.listFolders()), [{ uri, name: src }]);
});
