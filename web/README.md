# 克克卡库浏览器版（单一 HTML 文件）

把同一份 `app/src/main/assets/index.html` 建置成一个可以直接用浏览器打开的 HTML 文件：`kaku-web-<版本>.html`。不需要安装，Windows、macOS、Linux 的 Chrome / Edge 都能用。页面一份，安卓 APK、桌面 exe、浏览器版共用；建置时才在页面末尾附加浏览器外壳，原页面不改。

## 下载与使用

- 用 **Chrome 或 Edge** 打开：双击 HTML 文件，或把它拖进浏览器窗口。也可以把它放到任何静态网站空间（NAS、自己的网站）后用网址打开。
- **数据存在浏览器里，不在 HTML 文件里。** 把 HTML 文件发给别人不会带上你的卡片；清除浏览器的网站数据、换浏览器、用无痕窗口，都看不到原来的卡片。
- **换新版**：Chrome / Edge 里，本机打开的 HTML 文件共用同一份网站存储，所以新版文件放在别的文件夹、换了文件名，仍会读到原来的卡片（已用 Chromium 测试）。Firefox、Safari 未测试，可能每个文件位置各有一份数据。**换版前先在设置页导出完整备份。**
- **导出的文件**在浏览器的下载列表 / 下载文件夹里。
- 与安卓版、桌面版的数据**不会自动同步**。迁移请用完整备份文件：在一边“导出完整备份”，另一边“恢复备份”。
- 手机浏览器打开本机 HTML 文件的支持参差不齐，手机上建议继续用 APK。

## 与安卓版的差异

浏览器里没有原生桥接，以下功能在浏览器版中隐藏或变灰（规则沿用原作者浏览器预览版）：

| 功能 | 浏览器版 | 原因 |
| --- | --- | --- |
| 酒馆双端互通 | 隐藏 | 需要原生网络桥接处理 Basic 认证、Cookie 与跨域 |
| WebDAV 云同步 | 隐藏 | 坚果云等服务不允许网页跨域访问 |
| 导入与文件夹扫描 | 隐藏 | 浏览器不能授权并反复扫描本机目录 |
| 实时备份目录（Data & Safety） | 隐藏 | 同上，需要长期写入用户指定目录 |
| 应用图标、检查更新 | 按钮变灰 | 安卓专属 |
| 多张卡打包成 ZIP 导出 | 页面提示暂未开放 | 页面本身的浏览器路径不支持，可改用“导出原始文件”逐项导出 |

其余功能（导入 PNG / JSON / ZIP、整理、标签、分组、风格工坊、完整备份与恢复、导出原始文件等）与安卓版相同。AI 整理与 AI 诊断由浏览器直接请求你填写的 AI 服务，只有允许网页跨域访问的服务能用（未逐一测试）。

## 从 GitHub Actions 取得 HTML

`.github/workflows/web-html.yml` 会在 GitHub 的 Linux 机器上建置 HTML，并用 Chromium 跑测试。推送到 `main` 或 `claude/**` 分支、且改动了 `web/`、页面、版本号或授权文件时自动运行，也可以在 Actions 页面手动点 “Run workflow”。

下载：仓库的 **Actions** 页 → “浏览器版 HTML 建置” → 选一次运行 → 页面底部 **Artifacts** 里的 `kaku-web-<版本>-html`（zip，内含 HTML 和 SHA-256；需登录 GitHub，保留 30 天）。运行摘要里也会列出 SHA-256。

这个 workflow 不发布 Release，不改 `update.json`，也不改 `docs/`（GitHub Pages 上的浏览器预览版）。

## 建置

只需要 Node.js 18 或以上，不用安装任何依赖：

```bash
cd web
```

```bash
node build.js
```

输出 `web/dist/kaku-web-<版本>.html` 与同名 `.sha256`，并打印大小与 SHA-256。版本号读自 `app/build.gradle.kts` 的 `versionName` / `versionCode`，与 APK、exe 一致。

建置出的文件开头附有授权协议、第三方声明、原项目链接和对应源码位置（在 GitHub Actions 里是本次提交的链接，本地建置则写 git 提交号），满足 `LICENSE.md` 对分发的要求。

## 测试

```bash
cd web
```

```bash
npm ci
```

```bash
npx playwright install chromium
```

```bash
node build.js
```

```bash
npm test
```

测试用 Chromium 直接以 `file://` 打开建置出的文件（与用户双击相同），逐项检查：

1. 标题与版本号正确，没有原生桥接，外壳生效；
2. 设置页四个分页里，用不了的板块及其“快速查找”按钮已隐藏，安卓专属按钮变灰，“数据位置”说明改为浏览器；
3. 导入 PNG、JSON 角色卡和含两张卡的 ZIP（预检 → 确认写入）；
4. 导出单张原文件与完整备份（浏览器下载）；
5. 关闭浏览器再打开，卡片仍在；
6. 新版文件放在别处、改了名字，仍读到同一份数据；
7. 清空卡库后用备份文件恢复；
8. 电脑宽度截图；
9. 全程没有对外网络请求、没有页面错误。

截图与结果在 `web/test-output/`。也可以用 `KAKU_WEB_HTML=<路径>` 测指定的 HTML 文件。

## 文件结构

```
web/
  build.js                  建置脚本（无依赖）
  shell/browser-shell.js    浏览器外壳：隐藏板块、按钮变灰、改写数据位置、弹窗适配可见视口
  shell/browser-shell.css   外壳样式（沿用 docs/browser-layout.css，去掉了会把电脑上的弹窗撑满整屏的宽度限制）
  test/run.js               Chromium 端到端测试
```

外壳只在没有原生桥接时生效：同一个 HTML 放进安卓 App 或桌面版里不会有任何影响。外壳靠板块标题（`Local Tavern`、`Cloud Sync` 等）和按钮的 `onclick` 识别要处理的元素；页面改版后若这些文字变了，建置会打印警告、测试会失败，按提示修改 `shell/browser-shell.js` 即可。

## 与 GitHub Pages 预览版的关系

`docs/index.html` 是另外维护的预览页面，本建置不会读取或覆盖它。如果以后想让 Pages 预览版也由这里自动生成，可以把 `dist/kaku-web-<版本>.html` 改名为 `index.html` 放进 `docs/`，但请先确认 `app/src/main/assets/index.html` 已包含 `docs/index.html` 里较新的修改。
