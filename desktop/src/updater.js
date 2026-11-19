'use strict';
// 对应 AppUpdater.java 的“检查更新”部分：读取项目 update.json，有新版时只提示并打开下载页，不自动安装。
const { dialog, shell } = require('electron');
const { httpBuffer } = require('./http');
const U = require('./util');

const META = 'https://raw.githubusercontent.com/kitten112233/keke-card-library/main/update.json';
const RELEASES = 'https://github.com/kitten112233/keke-card-library/releases/';

function createUpdater(ctx) {
  let busy = false;
  const metaUrl = () => (!ctx.isPackaged && process.env.KAKU_UPDATE_URL) || META;

  function downloadPage(meta) {
    if (typeof meta.desktopUrl === 'string' && meta.desktopUrl.startsWith(RELEASES)) return meta.desktopUrl;
    const v = String(meta.versionName || '').replace(/[^0-9A-Za-z._-]/g, '');
    return v ? RELEASES + 'tag/v' + v : RELEASES + 'latest';
  }

  async function run() {
    try {
      const r = await httpBuffer({
        method: 'GET', url: metaUrl(), session: ctx.sessions.update, cookies: false,
        httpsOnlyRedirects: true, maxRedirects: 8, connectTimeout: 20000, readTimeout: 30000,
      }, 65536, new Error('版本信息过大'));
      if (!/^https:/i.test(metaUrl())) throw new Error('更新地址必须使用 HTTPS');
      if (r.status !== 200) throw new Error('服务器返回 ' + r.status);
      const meta = JSON.parse(r.body.toString('utf8'));
      const remote = Number(meta.versionCode);
      if (!Number.isInteger(remote)) throw new Error('JSONObject["versionCode"] is not an int');
      if (remote <= ctx.version.code) { ctx.toast('当前已是最新版本'); return; }
      // 与 Java 相同的来源与校验信息检查（桌面版不下载 APK，但用它确认这份版本信息可信）
      if (typeof meta.apkUrl !== 'string' || !meta.apkUrl.startsWith(RELEASES + 'download/')) throw new Error('更新来源不正确');
      if (!/^[a-fA-F0-9]{64}$/.test(String(meta.sha256 || ''))) throw new Error('缺少有效校验信息');
      const page = downloadPage(meta);
      const res = await ctx.showMessageBox({
        type: 'info',
        title: '发现新版 ' + String(meta.versionName || ''),
        message: '发现新版 ' + String(meta.versionName || ''),
        detail: String(meta.notes || '') + '\n\n桌面版不会自动安装：打开下载页取得新版 exe，替换旧文件即可，卡库数据不受影响。',
        buttons: ['打开下载页', '稍后'],
        defaultId: 0, cancelId: 1, noLink: true,
      });
      if (res && res.response === 0) await shell.openExternal(page);
    } catch (e) {
      ctx.toast('检查更新失败：' + U.errMsg(e));
    } finally { busy = false; }
  }

  return {
    check() {
      if (busy) { ctx.toast('更新任务正在进行'); return; }
      busy = true;
      ctx.toast('正在检查更新…');
      run();
    },
    downloadPage,
  };
}

module.exports = { createUpdater, META };
