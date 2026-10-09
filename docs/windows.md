# Windows 使用与开发

工作区根目录就是这份 Git 仓库，无需再复制或下载第二份项目。`1.2.0-beta.2` 增加 Windows x64 支持；功能修改使用独立开发分支。依赖固定在 `package-lock.json`，无需改变系统 PowerShell 执行策略。

## 日常阅读

普通用户可从 [GitHub Release](https://github.com/Zeen-F/PDF_Vibecoding/releases/tag/v1.2.0-beta.2) 下载 `Paperdesk-1.2.0-beta.2-win-x64.zip`，完整解压后双击 `Paperdesk.exe`；无需安装 Node.js。保留整个解压目录，不能只移动 EXE。`SHA256SUMS-win` 提供校验值。此预览包未签名；更新时先正常退出，再替换应用目录，文献库保存在应用目录之外。

双击根目录的 **启动纸间.cmd**。首次缺少依赖或界面时自动准备，随后打开默认浏览器中的 <http://127.0.0.1:4317>。使用完毕回到启动窗口按 **Ctrl+C**，等服务停止后再关闭窗口。关掉网页标签不会停止服务。已有兼容服务只在版本和文献库身份一致时复用；复用的第二个启动窗口结束不会停止第一个窗口拥有的服务。

浏览器版正式文献库在根目录 `data/`，首次运行才创建。原 Mac 文献库未包含在源码中；如果要继续用已有资料，先正常退出 Mac 程序，复制完整文献库一次，再明确选择或配置该位置，不能只复制数据库主文件。

Windows 桌面版可直接打开 `release/win-unpacked/Paperdesk.exe`（目录包构建后）。整个 `win-unpacked` 目录是一套应用，不能只移动其中的 EXE。桌面文献库默认在 `%APPDATA%/Paperdesk/library/`，与浏览器版 `data/` 分开；使用菜单“文件 → 打开已有文献库…”可以明确连接现有完整库，资料不自动搬迁。Windows 关闭按钮等待待保存内容后退出；保存失败会提示保留窗口。

桌面配置、草稿在 `%APPDATA%/Paperdesk/`，Obsidian 库外索引在其中的 `vault-cache/`。菜单可打开已有 Obsidian 知识库，原始 PDF 保持位置与内容。正式 Markdown 和 PDF 是资料，索引缓存不替代它们。

## 从 Codex 打开纸间

本仓库同时提供原生阅读插件。先在一个终端运行 `npm.cmd start`，在另一个终端执行 `npm.cmd run plugin:install`，再在 Codex 新会话启用“纸间 Paperdesk”并说“打开纸间阅读器”。首次连接空的 Windows 工作区会使用新的正式 `data/`；不会复制 Mac 的个人资料。插件安装后可自动启动已经绑定的默认库；自定义库和端口需先手动启动服务。四套皮肤、选区讨论和笔记保护共用现有插件能力，详细边界见 [Codex 插件说明](codex-plugin.md)。

## 开发

安装 Node.js 24 LTS 后，在本文件夹的 PowerShell 中执行：

```powershell
npm.cmd ci
npx.cmd playwright install chromium
npm.cmd run dev
```

打开 <http://127.0.0.1:5173>。开发 API 默认使用 4318，开发库为 `.local/dev-data/`，不会沿用正式 Obsidian 配置。按 Ctrl+C 停止本次界面和 API 服务。编辑器可以直接打开根目录 `PDF_Vibecoding.code-workspace`。

更新源码后重建日常阅读界面：

```powershell
npm.cmd run build
npm.cmd start
```

`npm.cmd start` 保持服务运行，浏览器手动打开 4317；双击启动器会自动打开浏览器。启动器已有 `dist/` 时不会自动识别源码修改，修改后务必重新构建。

PowerShell 的环境变量写法如下，仅对当前窗口生效：

```powershell
$env:PAPERDESK_DATA_DIR = 'D:\PaperdeskLibrary'
$env:PORT = '4320'
npm.cmd start
```

使用 Obsidian 浏览器模式时设置 `PAPERDESK_VAULT_DIR` 为包含 `.obsidian` 的知识库根目录，`PAPERDESK_DATA_DIR` 必须位于整个知识库之外。日常阅读不需要翻译密钥或 Codex 插件；不要将自己的密钥写进源码。

## 检查与打包

```powershell
npm.cmd run check
npm.cmd run test:desktop
npm.cmd run test:desktop:reliability
node scripts/test-vault-desktop.mjs
```

测试使用隔离临时资料，默认结束后删除合成库和截图。只有需要保留故障证据时设置 `PAPERDESK_ACCEPTANCE_DIR` 到忽略的 `.local/` 内专用目录；它不是正式资料库，使用结束后按实际用途清理。

```powershell
npm.cmd run desktop:pack:win
npm.cmd run test:desktop -- --packaged release/win-unpacked/Paperdesk.exe
```

目录包足以在本机使用与验收。公开分发使用 `npm.cmd run desktop:dist:win:zip` 生成 ZIP，发布流程从 ZIP 解压后执行完整桌面验收。需要单文件分发时，原 `npm.cmd run desktop:dist:win` portable EXE 入口仍保留，但 portable 不在本次公开发布范围。按用途保留一套本机成品，不积累目录包、portable、多轮 ZIP 和多份旧源码。Mac 打包入口保留，两种系统分别验收。

Windows ZIP 生成后，`npm.cmd run release:checksums -- --windows-format zip` 写入 `release/SHA256SUMS-win`。省略格式参数时仍选择 portable EXE。Mac 入口继续使用原 `SHA256SUMS`；另一系统可显式追加 `--platform win32` 或 `--platform darwin`。目录包日常使用无需生成分发包或校验文件。

## 工作区保留规则

- 保留源码、锁文件、文档、一套依赖和当前构建；历史使用 Git 查找。
- 保护正式 `data/`、开发库、已有 Obsidian 知识库及迁移恢复资料。仅清理能确认由本次测试产生的临时内容。
- 测试成功或失败都要关闭本次子进程；释放端口前核对服务身份。不要全局终止所有 Node、Electron 或浏览器进程。
- 本机检查摘要集中在一份 `.local/windows-verification.json` 中覆盖更新，不累计按日期编号的报告和备份。
