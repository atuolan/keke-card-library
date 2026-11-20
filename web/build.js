'use strict';
// 建置浏览器版单一 HTML 文件（不需要安装任何依赖，只要 Node.js 18 以上）：
//  1. 从 app/build.gradle.kts 读 versionName / versionCode（与 Android、桌面版一致）
//  2. 读取 app/src/main/assets/index.html（与 APK、exe 用的是同一个页面，不另外维护副本）
//  3. 文件开头附上授权协议与第三方声明，末尾附加 shell/ 里的浏览器外壳
//  4. 输出 dist/kaku-web-<版本>.html 及其 SHA-256
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const WEB = __dirname;
const ROOT = path.resolve(WEB, '..');
const PAGE = path.join(ROOT, 'app', 'src', 'main', 'assets', 'index.html');
const GRADLE = path.join(ROOT, 'app', 'build.gradle.kts');

// 外壳依赖的页面文字；页面改版后找不到时要更新 shell/browser-shell.js
const SHELL_MARKERS = ['Local Tavern', 'Cloud Sync', 'Import & Folder Scan', 'Data & Safety', '卡库主体：应用私有 IndexedDB', 'openLauncherIcons', 'checkAppUpdate', 'function buildSettingsQuickNav('];

function parseGradle(text) {
  const name = /versionName\s*=\s*"([^"]+)"/.exec(text);
  const code = /versionCode\s*=\s*(\d+)/.exec(text);
  if (!name || !code) throw new Error('无法从 build.gradle.kts 读取 versionName / versionCode');
  return { name: name[1], code: Number(code[1]) };
}

function sourceLine() {
  // 以实际检出的提交为准：定时任务可能从 main 触发、却检出别的分支来建置，此时 GITHUB_SHA 不是建置用的提交
  let sha = '';
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { /* 不是 git 仓库 */ }
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
  sha = sha || GITHUB_SHA || '';
  if (GITHUB_REPOSITORY && sha) return `本文件对应源码：${GITHUB_SERVER_URL || 'https://github.com'}/${GITHUB_REPOSITORY}/tree/${sha}`;
  if (sha) return '本文件由本地源码建置，git 提交：' + sha;
  return '';
}

function htmlComment(text) {
  if (/<!--|--!?>/.test(text)) throw new Error('授权文字里含有 HTML 注释符号，无法放进注释');
  return '<!--\n' + text.trim() + '\n-->\n';
}

function build({ outDir = path.join(WEB, 'dist') } = {}) {
  const version = parseGradle(fs.readFileSync(GRADLE, 'utf8'));
  const page = fs.readFileSync(PAGE, 'utf8');
  const doctype = /^﻿?<!DOCTYPE html>\r?\n/i.exec(page);
  if (!doctype) throw new Error('index.html 没有以 <!DOCTYPE html> 开头');

  const js = fs.readFileSync(path.join(WEB, 'shell', 'browser-shell.js'), 'utf8');
  const css = fs.readFileSync(path.join(WEB, 'shell', 'browser-shell.css'), 'utf8');
  if (/<\/script/i.test(js) || /<\/style/i.test(css)) throw new Error('外壳脚本或样式里不能出现 </script 或 </style');

  const missing = SHELL_MARKERS.filter((s) => !page.includes(s));
  if (missing.length) console.warn('警告：页面里找不到外壳依赖的文字，请检查 web/shell/browser-shell.js：', missing.join('、'));

  const about = [
    `克克卡库 浏览器版 v${version.name}（${version.code}）`,
    '基于克克卡库（kitten112233）：https://github.com/kitten112233/keke-card-library',
    '由 web/build.js 从 app/src/main/assets/index.html 生成，末尾附加了 web/shell/ 的浏览器外壳。',
    sourceLine(),
  ].filter(Boolean);
  const header = htmlComment([
    ...about,
    '',
    fs.readFileSync(path.join(ROOT, 'LICENSE.md'), 'utf8').trim(),
    '',
    fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8').trim(),
  ].join('\n'));

  const html = doctype[0] + header
    + page.slice(doctype[0].length).replace(/\s*$/, '\n')
    + '<style id="kaku-web-shell-style">\n' + css.replace(/\s*$/, '\n') + '</style>\n'
    + `<script id="kaku-web-shell" data-version="${version.name}">\n` + js.replace(/\s*$/, '\n') + '</script>\n';

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `kaku-web-${version.name}.html`);
  fs.writeFileSync(file, html);
  const sha = crypto.createHash('sha256').update(html).digest('hex');
  fs.writeFileSync(file + '.sha256', sha + '  ' + path.basename(file) + '\n');
  return { file, sha, size: Buffer.byteLength(html), version };
}

if (require.main === module) {
  try {
    const r = build();
    console.log('版本（来自 app/build.gradle.kts）：', r.version.name, '/', r.version.code);
    console.log('输出：', r.file, '\n大小：', r.size, 'bytes\nSHA-256：', r.sha);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

module.exports = { build, parseGradle };
