# 克克卡库 Windows 桌面版

用 Electron 包装同一份 `app/src/main/assets/index.html`：页面不做任何修改，桌面版在 preload 里实现了与 Android 端同名、同签名、同返回格式的 8 个原生桥（`AndroidDL`、`StHttpBridge`、`AndroidFolder`、`AndroidAI`、`AndroidGuard`、`AndroidDiagnosis`、`AndroidNav`、`AndroidPicker`）。页面一份，Android 与桌面共用；打包时才把 `app/src/main/assets` 复制进 exe。

## 下载与运行

- 产物是**免安装单一 exe**：`kaku-desktop-<版本>.exe`，适用于 Windows 10 / 11（64 位）。双击即可运行。
- exe 未签名，首次运行可能出现“Windows 已保护你的电脑”：点“更多信息” → “仍要运行”。
- portable 形式每次启动都会先把程序解压到临时目录，所以启动比一般程序慢几秒，属正常现象。
- **数据位置**：`%APPDATA%\KaKu`（卡库数据库、设置、可续传的导入暂存都在这里）。exe 可以随意移动或替换成新版，数据不受影响；删除这个目录等于 Android 上的“清除应用数据”。
- **导出文件**：保存到 `%USERPROFILE%\Downloads\卡库`，同名文件自动改名为 `名称 (1).扩展名`，不会覆盖。
- 与 Android 的数据**不会自动同步**。迁移请用完整备份文件、实时备份目录或 WebDAV。
- **更新**：设置页“检查更新” → 发现新版时提示 → 点“打开下载页” → 下载新的 exe 替换旧的即可。桌面版不自动下载、不自动安装。

## 从 GitHub Actions 取得 exe

仓库里的 `.github/workflows/desktop-windows.yml` 会在 GitHub 的 Windows 机器上建置 exe，并在 Windows 上跑单元测试和端到端测试。推送到 `main` 或 `claude/**` 分支、且改动了 `desktop/`、页面、图标或版本号时自动运行，也可以在 Actions 页面手动点 “Run workflow”。

下载：仓库的 **Actions** 页 → “桌面版 Windows 建置” → 选一次运行 → 页面底部 **Artifacts** 里的 `kaku-desktop-<版本>-windows-x64`（zip，内含 exe 和 SHA-256；需登录 GitHub，保留 30 天）。运行摘要里也会列出 SHA-256。

fork 出来的仓库默认不运行 workflow，第一次需要在 Actions 页点 “I understand my workflows, go ahead and enable them”。这个 workflow 不发布 Release，也不改 `update.json`。

## 建置

需要 Node.js 20 或以上（含 npm）。Windows、Linux、macOS 都可以建置 Windows exe，不需要 Wine。

```bash
cd desktop
```

```bash
npm ci
```

```bash
npm run build:win
```

输出：

- `dist/kaku-desktop-<versionName>.exe`：发布用的单一 exe
- `dist/kaku-desktop-<versionName>.exe.sha256`：该 exe 的 SHA-256

建置脚本 `scripts/build-win.js` 会：

1. 从 `app/build.gradle.kts` 读取 `versionName` / `versionCode`，保证与 Android 一致（写入 `src/build-info.json`，检查更新时用 versionCode 比较）；
2. 把 `app/src/main/res/mipmap-xxxhdpi/ic_launcher.png` 转成 `build/icon.ico`（16～256 共 10 个尺寸；原图只有 192×192，256 尺寸为放大生成）；
3. 用 electron-builder 的 portable target（x64）打包，`app/src/main/assets`、`LICENSE.md`、`THIRD_PARTY_NOTICES.md` 放进 `resources/`。

`npm ci` 和首次建置需要从 GitHub 下载 Electron 及 electron-builder 的工具包。网络受限时可设置镜像，例如：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm ci
```

## 开发与测试

```bash
npm start
```

开发模式直接读取 `../app/src/main/assets/index.html`，改完页面重开窗口即可。窗口内 F12 打开开发者工具，Ctrl + / Ctrl - / Ctrl 0 缩放。

```bash
npm test
```

单元测试：解析 `MainActivity.java`，确认 8 个桥的方法名与 Java `@JavascriptInterface` 一个不多、一个不少，页面调用的每个方法都存在；另测 ZIP 安全规则、文件名清理、User 设定局部替换、文件夹扫描分页、实时备份提交与删除规则等。

```bash
xvfb-run -a npm run test:e2e
```

端到端测试：启动真正的桌面版，用页面自己的函数逐个流程跑一遍（导入、导出、恢复备份、文件夹扫描、酒馆 HTTP、酒馆文件夹、User 设定写回、实时备份写入与恢复、WebDAV 云同步、AI、检查更新、返回键）。WebDAV 模拟服务完全不返回 CORS 响应头、对预检返回 401，并通过局域网地址的 http 访问。系统对话框在测试中被替换为直接返回测试目录；酒馆服务器是照 SillyTavern 1.19 源码实现的本地模拟服务。Windows 上不需要 `xvfb-run`。

对打包后的程序跑同一套测试（在 Linux 上验证 asar、`resources/assets`、版本号等打包行为）：

```bash
node scripts/build-win.js --linux-dir
```

```bash
KAKU_E2E_EXECUTABLE=$PWD/dist-linux/linux-unpacked/KaKu xvfb-run -a npm run test:e2e
```

测试用环境变量：`KAKU_USER_DATA_DIR`（数据目录）、`KAKU_DOWNLOADS_DIR`（导出目录）、`KAKU_UPDATE_URL`（仅开发模式生效的更新地址）。

## 目录结构

| 文件 | 作用 | 对应 Android |
|---|---|---|
| `src/main.js` | 窗口、`kaku://app/` 协议、IPC 分发、安全设置 | `MainActivity`（WebView 外壳部分） |
| `src/preload.js` | contextBridge 暴露 8 个桥，`ipcRenderer.sendSync` 保持同步语义；Toast 浮层；记录选中文件路径；返回键 | `addJavascriptInterface`、`Toast`、`onBackPressed` |
| `src/bridges/download.js` | `AndroidDL` | `DownloadBridge` |
| `src/bridges/sthttp.js` | `StHttpBridge` | `StHttpBridge` |
| `src/bridges/folder.js` | `AndroidFolder` | `FolderBridge` |
| `src/bridges/small.js` | `AndroidAI`、`AndroidGuard`、`AndroidDiagnosis`、`AndroidNav`、`AndroidPicker` | 同名各类 |
| `src/updater.js` | 检查更新 | `AppUpdater`（仅检查部分） |
| `src/zip.js` / `src/litelist.js` / `src/persona-json.js` | ZIP 读写、角色列表流式解析、settings.json 局部替换 | `ZipFile`/`ZipOutputStream`、`JsonReader`/`JsonWriter` |
| `src/prefs.js` | 偏好设置（原子写入 JSON） | `SharedPreferences` |

路径对应：

| Android | 桌面版 |
|---|---|
| `getFilesDir()/transfer_staging` | `%APPDATA%\KaKu\files\transfer_staging` |
| `getCacheDir()`（扫描副本、酒馆大响应临时文件） | `%APPDATA%\KaKu\cache`（启动时清理，可续传暂存不清） |
| SharedPreferences | `%APPDATA%\KaKu\prefs\*.json` |
| 下载/卡库 | `%USERPROFILE%\Downloads\卡库` |
| SAF 目录授权 URI | 用户在 Windows 文件夹对话框中选的目录；页面拿到的 `uri` 是 `file:///` 地址 |
| WebView IndexedDB / localStorage | `%APPDATA%\KaKu`（Chromium 用户数据） |

## 与 Android 版的差异

**行为对应**

- 目录授权：SAF 文件夹选择 → Windows 文件夹对话框（扫描目录、酒馆存档点、实时备份目录）。选择是非同步的，完成后照样回调页面的 `onScanFolderChosen` / `onTavernFolderChosen` / `onSafetyFolderChosen`。
- 文件选择：“系统文件 / 其他文件管理器”在桌面上都是同一个 Windows 文件对话框，`AndroidPicker` 只记录设置、不改变行为。用对话框选的文件和拖进窗口的文件都会走原生后台复制暂存（`beginSelectedStage`）。
- 应用图标：`setLauncherIcon` 改为切换窗口和任务栏图标，下次启动沿用；exe 文件本身的图标固定为默认的第 2 款。
- 返回键：鼠标侧键“后退”或 Alt+← 调用页面的 `_handleNativeBack`，逐层关闭弹窗；全部关闭后**不退出**，退出请关闭窗口。关闭窗口时如果正在写文件（导出、暂存复制、酒馆写回、实时备份），会先询问。
- 检查更新：读取与 Android 相同的 `update.json`（kitten112233/keke-card-library 的 main 分支），比较 versionCode；有新版时只弹窗并打开 Release 页面，不下载、不安装。若之后 `update.json` 增加 `desktopUrl`（必须是该仓库 releases 下的地址），优先打开它。
- 网络：酒馆和 AI 请求改用 Chromium 网络栈，会使用 Windows 的系统代理设置。酒馆 cookie 与 Android 一样只保存在内存，重开程序后重新获取。
- 跨域：Android 页面以 `file://` 载入并允许访问任意来源，所以页面直接 `fetch` 第三方服务（WebDAV / 坚果云云同步）不受 CORS 限制。桌面版对主页面（`Origin: kaku://app`）发出的跨域请求补上 CORS 响应头并放行预检请求，效果相同；卡片美化预览等沙盒 iframe 不在此列。另外与 Android 的 `MIXED_CONTENT_ALWAYS_ALLOW` 一样，允许访问 `http://` 地址（如局域网 NAS 的 WebDAV）。
- 诊断报告：结构不变，`source` 为 `windows-desktop`；Android 专属字段（SDK、厂商、WebView 包名）换成系统版本、Electron / Chromium 版本；脱敏规则额外处理 Windows 路径。

**实现上更稳妥的地方**

- 导出：先写 `*.part`，完成后再改名；中途放弃或失败不会留下半个文件。同名不覆盖。
- 写入酒馆目录：先写隐藏临时文件 `.名称.kaku-tmp-xxxx`，完成后改名，酒馆不会读到写了一半的 PNG。
- User 设定写回：Android 会把 `settings.json` 整份重写成无缩进格式；桌面版只替换 `power_user.personas` 和 `power_user.persona_descriptions` 两个值，其余内容（缩进、大整数等）逐字保留。校验 → 暂存 → 备份 → 写回 → 核验 → 失败时从备份恢复的流程不变。
- ZIP 导入：`safeZipEntry` 规则不变（只收 png/json/txt/docx/md/jsonl、单条 ≤32MB、压缩比 ≤200，解压时实际超过 32MB 立即中止）。另外，没有 UTF-8 标志的 GBK 中文文件名（Windows 压缩软件常见）会按 GBK 解码；Android 版遇到这种 ZIP 会整包报错。导出 ZIP 时，条目名含 `..` 会被拒绝。
- 文件夹扫描跳过符号链接和目录联接（junction），不会顺着链接跑出授权目录；OneDrive 云端文件照常扫描。

**比 Java 版收紧的权限**（Java 版受 Android 沙盒保护，桌面没有这层保护）

- `StHttpBridge.readSpillChunk` / `deleteSpill`：只能读、删 `%APPDATA%\KaKu\cache` 下的 `st_*.tmp`（Java 版可读任意路径）。
- `AndroidFolder.readChunk`：只能读扫描副本目录；`readTavernChunk`：只能读已授权的酒馆目录；`beginSafetyRead` / `readSafetyChunk`：只能读实时备份目录中的文件；`scanFolder`：只能扫描已添加的目录。
- 写入酒馆目录、实时备份目录、下载目录时，文件名在 Java 规则之外，再过滤反斜杠、控制字符、结尾的点和空格，以及 `CON`、`NUL` 等 Windows 保留名。
- `safePart` 规则不变，另外把 `.`、`..` 替换掉，防止跳出暂存目录。
- `AndroidNav.openUrl` 只接受 `http`、`https`、`mailto`。multipart 上传的文件名去掉引号和换行。
- 桥只注入主框架；页面里 iframe 预览拿不到桥（Android 的 `addJavascriptInterface` 会注入所有框架）。

## 安全设置

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；页面拿不到 `require`、`process` 或任何 Node API。
- 页面通过自定义协议 `kaku://app/` 提供，只能读到 assets 目录。桥只接受来自主窗口主框架、`kaku://app` 来源的调用。
- 外部链接和新窗口一律交给系统浏览器，不允许导航离开 `kaku://app`；权限请求只放行剪贴板写入和全屏。
- 单实例运行，避免两个进程同时打开同一个数据库。
- **页面来源 `kaku://app` 以后不能改**：IndexedDB 按来源保存，改了之后卡库会显示为空。

## 测试情况与待实测项目

- 在 Linux 容器中（Electron 45.2.2，Xvfb）通过：单元测试 13 项；端到端测试 14 项；同一套端到端测试也对打包后的程序跑过。Windows 上的结果见 GitHub Actions 运行记录。
- 酒馆 HTTP 互通测试的是照 SillyTavern 1.19 源码实现的本地模拟服务（Basic 认证、cookie-session 签名 cookie、csrf-sync、角色列表 / 导入 / 取图），**不是真正的 SillyTavern**。
- **尚未在 Windows 实机上运行**。需要在 Windows 上确认：文件夹/文件对话框、Downloads 位置、系统代理、任务栏图标切换、SmartScreen 提示、portable 解压速度、中文路径和 OneDrive 目录、杀毒软件是否误报。
