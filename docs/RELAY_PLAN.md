# 网页版云同步：WebDAV 中转方案（讨论稿）

状态：待讨论，尚未实现。云同步本身的修复（文件名带角色名、只传新增与修改的卡）在分支 `claude/kind-lovelace-ujs39s`，与本方案无关。

## 为什么网页版不能直接用云同步

- APK 用 `file://` 打开页面，并开启了 `setAllowUniversalAccessFromFileURLs(true)`（`MainActivity.java`），浏览器的跨域（CORS）限制不生效，可以直连坚果云。
- 网页版在 `github.io` 上，对坚果云发 PROPFIND / PUT 等请求属于跨域请求。坚果云不返回 CORS 响应头（社区普遍经验，尚未在大陆网络实测），浏览器会拦截，所以 `docs/web-preview.js` 把云同步卡片隐藏了。
- 解决思路：自己部署一个中转。浏览器 → 中转 → 坚果云。卡片仍然存在坚果云，中转本身不存任何数据。

## 已确认的情况（2026-11-19）

- HF Space `lonson0215/aguaphone-sync` 是小手机的自建同步后端（账号 + SQLite + WebSocket），不是 WebDAV 中转。
  - 小手机在网页能同步，是因为这台服务器自己返回 `Access-Control-Allow-Origin: *`。
  - 免费 Space 的硬盘是临时的，重启或休眠（闲置 48 小时）后数据会清空。卡库的云同步是备份，不适合把卡直接存在它上面。
  - 它按条数分页（一页默认 300 条），请求体也没有大小上限。一张卡转成 base64 后有几 MB，不适合这种设计。
- HF 的入口会放行任意方法（包括 PROPFIND、PUT）的跨域预检，并返回 `access-control-expose-headers: *`，浏览器能读到 ETag。卡库现在的同步必须读到 ETag。
- 大陆访问（未在大陆网络实测）：
  - `huggingface.co` 被封锁。
  - `hf.space` 近期有用户反映连不上。
  - Cloudflare `workers.dev` 有被 SNI 阻断的记录，绑定自己的域名通常可用，但不保证。

## 中转需要做到的

| 项目 | 要求 |
|---|---|
| 路径 | `/dav/<相对路径>` 转发到 `https://dav.jianguoyun.com/dav/<相对路径>`；目标主机写死或用白名单，不能变成公开代理 |
| 方法 | GET、PUT、DELETE、MKCOL、PROPFIND、MOVE、OPTIONS |
| 请求头 | 透传 `Authorization`、`Depth`、`If-Match`、`If-None-Match`、`Content-Type`、`Overwrite`；`Destination`（MOVE 用）要从中转地址改写成坚果云地址 |
| 响应 | 原样回传状态码（包括 207、404、412）、响应体和 `ETag` |
| 跨域 | `Access-Control-Allow-Origin` 只允许卡库网页的来源；`Allow-Methods` 和 `Allow-Headers` 包含上面列出的方法和请求头；`Access-Control-Expose-Headers: ETag`；OPTIONS 直接返回 204 |
| 传输 | 请求体和响应体都用流式转发，不要整包读进内存（单张卡可能有几 MB） |
| 防蹭用 | 自定义请求头（例如 `X-Kaku-Relay-Key`），和中转的环境变量比对，不一致就拒绝 |
| 隐私 | 不记录 `Authorization`，不把任何内容写入磁盘 |

## 卡库端需要改的

- 设置页增加「中转地址」「中转密钥」两栏，和现有设置一起存在 `webdavConfig`。
- `wdFetch`：填了中转地址时，请求改发到 `中转地址/dav/<相对路径>`，并带上密钥头；没填时保持直连。
- MOVE 的 `Destination`（`wdAbsUrl`）：经过中转时写成中转地址，由中转改写成坚果云地址。
- `docs/web-preview.js`：不再隐藏云同步卡片；没填中转地址时，显示说明并引导改用 APK。
- APK 不受影响，中转地址可以留空。

## 部署选项

| 部署在哪 | 大陆能否直连 | 代价 |
|---|---|---|
| HF Space | 很可能要开 VPN | 免费；休眠后第一次请求较慢 |
| Cloudflare Worker + 自有域名 | 通常可以，不保证 | 需要买一个域名 |
| 国内云函数（阿里云、腾讯云） | 稳定 | 需要实名认证；绑定自有域名要备案；可能有少量费用 |
| 自己的 NAS / VPS | 视网络环境 | 如果已经在用 Nextcloud 等 WebDAV 服务，可以直接开启 CORS，不用中转 |

## 待讨论

1. 先做哪几个版本？建议先做 HF 版和 Cloudflare Worker 版，两者共用同一套转发逻辑。
2. 是否提供一个公用中转？不建议：所有用户的坚果云密码都会经过同一台服务器。建议每个人自己部署。
3. 网页版本身放在 `github.io`，在大陆访问也不稳定。是否需要国内托管？
4. 坚果云免费版的流量和请求频率限制，具体数值待查官方说明，以评估大量改名、上传时会不会被限流。
