'use strict';
// 建置 Windows 免安装单一 exe：
//  1. 从 app/build.gradle.kts 读 versionName / versionCode（与 Android 一致），写入 src/build-info.json
//  2. ic_launcher.png → build/icon.ico
//  3. electron-builder portable x64，页面 app/src/main/assets 在打包时复制进 resources/assets
//  4. 输出 dist/kaku-desktop-<版本>.exe 并打印 SHA-256
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseGradle } = require('../src/version');
const { makeIco } = require('./make-icon');

const DESKTOP = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP, '..');

async function main() {
  const version = parseGradle(fs.readFileSync(path.join(ROOT, 'app', 'build.gradle.kts'), 'utf8'));
  fs.writeFileSync(path.join(DESKTOP, 'src', 'build-info.json'), JSON.stringify({ versionName: version.name, versionCode: version.code }, null, 2) + '\n');
  console.log('版本（来自 app/build.gradle.kts）：', version.name, '/', version.code);
  const ico = makeIco(path.join(ROOT, 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi', 'ic_launcher.png'), path.join(DESKTOP, 'build', 'icon.ico'));
  console.log('图标：', ico);
  if (process.argv.includes('--prepare-only')) return;

  const builder = require('electron-builder');
  const config = {
    appId: 'com.operit.webviewapp.desktop',
    productName: '克克卡库',
    executableName: 'KaKu',
    copyright: 'kitten112233',
    directories: { output: 'dist', buildResources: 'build' },
    files: ['package.json', 'src/**/*'],
    extraResources: [
      { from: '../app/src/main/assets', to: 'assets', filter: ['**/*'] },
      { from: '../LICENSE.md', to: 'LICENSE.md' },
      { from: '../THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    ],
    extraMetadata: { version: version.name, main: 'src/main.js' },
    asar: true,
    electronLanguages: ['zh-CN', 'zh-TW', 'en-US'],
    win: {
      target: [{ target: 'portable', arch: ['x64'] }],
      icon: 'build/icon.ico',
      artifactName: 'kaku-desktop-${version}.${ext}',
      legalTrademarks: '克克卡库',
    },
    portable: { artifactName: 'kaku-desktop-${version}.${ext}', unpackDirName: 'KaKu-Desktop-' + version.name },
    publish: null,
  };
  if (process.argv.includes('--linux-dir')) {
    // 仅供在 Linux 上验证“打包后”的行为（asar、resources/assets、版本号），不是发布产物
    const out = await builder.build({ targets: builder.Platform.LINUX.createTarget('dir', builder.Arch.x64), config: { ...config, directories: { output: 'dist-linux', buildResources: 'build' } }, projectDir: DESKTOP });
    console.log('Linux 解包目录：', out);
    return;
  }
  const out = await builder.build({ targets: builder.Platform.WINDOWS.createTarget('portable', builder.Arch.x64), config, projectDir: DESKTOP });
  const exe = out.find((f) => /kaku-desktop-.*\.exe$/.test(f));
  if (!exe) throw new Error('没有找到输出的 exe：' + out.join(', '));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  fs.writeFileSync(exe + '.sha256', sha + '  ' + path.basename(exe) + '\n');
  console.log('\n输出：', exe, '\n大小：', fs.statSync(exe).size, 'bytes\nSHA-256：', sha);
}

main().catch((e) => { console.error(e); process.exit(1); });
