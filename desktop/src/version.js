'use strict';
// 版本号与 Android 保持一致：打包时由 scripts/build-win.js 从 app/build.gradle.kts 生成 build-info.json；
// 开发模式下直接读取 gradle 文件。
const fs = require('fs');
const path = require('path');

function parseGradle(text) {
  const name = /versionName\s*=\s*"([^"]+)"/.exec(text);
  const code = /versionCode\s*=\s*(\d+)/.exec(text);
  if (!name || !code) throw new Error('无法从 build.gradle.kts 读取 versionName / versionCode');
  return { name: name[1], code: Number(code[1]) };
}

function readVersion(isPackaged) {
  // 打包后的程序只认建置时写入的 build-info.json；开发模式直接读 gradle，避免用到上次建置留下的旧版本号。
  if (isPackaged) {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
    return { name: info.versionName, code: info.versionCode };
  }
  return parseGradle(fs.readFileSync(path.resolve(__dirname, '..', '..', 'app', 'build.gradle.kts'), 'utf8'));
}

module.exports = { readVersion, parseGradle };
