# 纸间 Paperdesk 桌面预览版

**1.2.0-beta.2** 桌面预览包面向 **Apple Silicon Mac（M 系列芯片）和 Windows x64**。Windows 使用解压即用 ZIP，使用及开发方法见 [Windows 指南](windows.md)。安装包带有运行环境，使用者无需安装 Node.js、开发工具或启动终端。

桌面版保留 PDF 导入、阅读、检索、文件夹、批注、笔记和 Markdown 导出，并增加 Obsidian 仓库与个人页面书签。应用在本机启动阅读服务，仅监听 `127.0.0.1`，退出时正常结束它管理的服务。

macOS 关闭窗口会先等待笔记和阅读位置保存，再隐藏窗口；点击 Dock 图标可重新显示。使用 **⌘Q／退出纸间** 才退出应用并停止它管理的服务。Windows 关闭按钮等待保存后直接退出并停止本次服务。保存失败时保留窗口与草稿；切换文献库和退出的保存过程中暂时锁定编辑，避免后续输入落到错误的文献库。

## 本版的仓库与书签

「文件 → 打开 Obsidian 仓库…」选择已有知识库根目录。侧边栏显示已有 PDF，点击原位阅读；外部 PDF 也可导入，副本保存在知识库内，外部原文件保留。笔记、批注和书签进入正式 Markdown，索引与翻译设置留在库外。详见 [仓库规则](obsidian-vault.md)。

工具栏「书签」可添加当前实际 PDF 页、改名、删除和跳转，退出与重开后保留。个人书签独立于 PDF 自带章节目录，不使用印刷页码偏移。详见 [书签使用说明](bookmarks.md) 和 [本版变更记录](history/1.2.0-beta.1.md)。

## 下载与安装

在 [1.2.0-beta.2 Release](https://github.com/Zeen-F/PDF_Vibecoding/releases/tag/v1.2.0-beta.2) 中下载：

- `Paperdesk-<版本>-mac-arm64.dmg`：推荐安装包。打开后将 **Paperdesk** 拖入“应用程序”，再从“应用程序”打开。
- `Paperdesk-<版本>-mac-arm64.zip`：解压后将 **Paperdesk.app** 放入“应用程序”。
- `SHA256SUMS`：两种安装包的 SHA-256 校验值，用于核对下载文件。
- `Paperdesk-<版本>-win-x64.zip`：Windows 完整解压后打开 `Paperdesk.exe`，使用 `SHA256SUMS-win` 校验。包未签名；按系统提示核对来源。

本项目公开发布源码与预览安装包；下载文件后可使用 `SHA256SUMS` 核对内容。

本预览版**未使用 Apple 开发者证书签名，也未经过 Apple 公证**。首次打开时 macOS 可能阻止运行。在确认安装包来源后，先尝试打开一次，再到 **系统设置 → 隐私与安全性** 查看相应提示，点击“仍要打开”并按系统要求确认。请遵循系统提示，不关闭系统的整体安全保护。不同 macOS 版本的提示可能略有差异。[Apple 的安装说明](https://support.apple.com/zh-cn/102445)

## 文献库与原始资料

桌面版默认使用稳定的用户数据目录中的独立文献库：Mac 位于 `~/Library/Application Support/Paperdesk/library/`，Windows 位于 `%APPDATA%/Paperdesk/library/`，与应用程序文件分开。卸载或替换应用不会自动删除这份文献库。应用设置记住所选文献库目录，重新打开时恢复。

已有源码版资料不会被自动搬迁。若要继续使用，先**正常停止原来的阅读服务**，再从应用菜单选择“打开已有文献库…”，选中同时包含 `paperdesk.sqlite` 和 `pdfs/` 的完整 schema 4／5 文献库目录。schema 4 库在启动时备份并升级，schema 3 或更早库的操作顺序见下文。运行中的 SQLite 可能还有未归并的 WAL 保存记录；校验会拒绝这种状态，请正常结束原服务后重试。

“打开已有文献库”引用所选目录，不复制、移动或删除该目录，也不改写原始 PDF 字节。阅读位置、笔记和批注仍由该库保存；实际编辑会更新数据库。请勿同时在多个 Paperdesk 服务中编辑同一文献库。

“打开已有文献库…”菜单先只读校验完整 schema 4／5 库，这一步不执行迁移；随后启动服务时为 schema 4 库创建一致性备份并升级到 schema 5。默认库或已记住库也在启动时升级。更高版本的库不降级；选错目录、缺失 PDF 或库检查失败时保留当前文献库，不创建替代库。Obsidian 仓库使用另一菜单入口，不把库外索引目录当成独立文献库打开。

启动时仅复用文献库身份、产品版本、API 版本、启动协议和健康检查全部匹配的本机服务。首选端口被其他库或不兼容服务占用时，桌面版在空闲本机端口启动自己的服务，不停止占用端口的程序。

更换文献库、更新应用或恢复旧版前，请先正常退出相关服务，再复制整个文献库目录作为备份。不能在服务运行时仅复制 `paperdesk.sqlite` 主文件。已有数据库版本升级仍遵循 [数据与备份说明](../README.md#数据与备份)；回退程序不意味着数据库能够降级。

桌面设置和文献库路径保存在本机，不进入 Git 或安装包。安装包只包含运行代码、界面、依赖及原创阅读示例，不包含 `data/`、`.local/`、数据库、个人 PDF、笔记、截图、环境变量或密钥。

## 升级到 1.2.0-beta.1

以下是首次进入 schema 5 的升级说明，beta.2 继续适用。从 beta.1 更新到 beta.2 不再增加数据库版本。

本版使用 **schema 5**，增加个人页面书签。旧数据库在任何建表或改表之前，通过 SQLite 在线一致性机制备份到数据目录的 `recoveries/migrations/`，并读回检查完整性和原版本；备份包含已提交的 WAL 内容，失败则停止升级。随后迁移在同一事务中完成，失败回滚，原有文献和 PDF 保留。

1. 正常退出旧应用和相关服务，备份完整独立文献库。Obsidian 模式备份完整 Paperdesk 管理目录、全部关联源 PDF 和库外数据目录。
2. 替换应用后启动。默认／已记住库自动升级；新选择的完整 schema 4／5 库可直接通过菜单打开。
3. 新选择 schema 3 或更早库时，先在本版浏览器包目录执行以下命令，将路径替换为实际完整文献库目录：

   ```sh
   npm ci --omit=dev
   PAPERDESK_DATA_DIR="/path/to/existing-library" npm start
   ```

   核对原文献、笔记和批注读回后，按 Control+C 正常停止，再在桌面菜单选择该目录。从源码运行时先执行 `npm ci` 和 `npm run build`。
4. 旧 v1／v2 仓库 Markdown 保持可读，成功保存时写入支持书签的 v3 状态，保留原位或导入 PDF 来源。回退旧程序时先停止新版并恢复升级前完整资料；不能只还原数据库而保留新格式 Markdown。

自动一致性备份只保存数据库，不能替代 PDF、管理 Markdown 和翻译设置的完整备份。不要删除新增表或降低 `user_version` 来回退。

## 从 beta.4 升级

以下保留 **beta.4 → beta.5 的历史升级流程**。当前用户升级到 beta.1 时使用上节步骤。beta.5 把主数据库从 schema 3 升级到 **schema 4**，增加批注请求幂等和阅读位置 writer／sequence 记录。迁移在事务中完成，失败回滚；文献、分类、笔记、批注和原始 PDF 保留。升级不移动资料，也不改写 PDF。

1. 正常退出旧桌面应用或停止使用该库的源码／浏览器服务。确认没有其他服务继续编辑同一库。
2. 复制**完整文献库目录**作为升级前备份，包括主库、原始 PDF 和已有翻译数据库。不能在服务运行时只复制主数据库。
3. 如果继续使用桌面默认库或已记住的库，替换应用后启动 beta.5，它会自动迁移该库。打开已有文献，核对笔记、批注和阅读位置。
4. 如果要在菜单中新选择一个 schema 3 库，先解压 beta.5 浏览器 ZIP 并进入包目录，使用 Node.js 24+ 执行：

   ```sh
   npm ci --omit=dev
   PAPERDESK_DATA_DIR="/path/to/existing-library" npm start
   ```

   将示例路径替换为实际的完整文献库目录。启动会自动迁移目标库；按终端输出在浏览器中打开并核对资料，按 Control+C 正常停止后，再从 beta.5 桌面菜单选择该目录。使用 beta.5 源码时，先执行 `npm ci` 和 `npm run build`，其余步骤相同。
5. 若需要回退 beta.4，先退出 beta.5 并停止相关服务，恢复升级前完整备份，再打开旧应用。旧版不能直接打开 schema 4 库；不要只删新增表或修改 `user_version`。

beta.5 的评论草稿在切标签、切文献和刷新时保留；保存失败或冲突时保留输入。新增批注在响应丢失后以原请求重试，避免重复新增；阅读位置按文献合并和顺序保存。草稿不是正式备份，强制退出或断电不能保证最后一次未提交写入已经完成。四项修复与限制见 [beta.5 变更记录](history/1.1.0-beta.5.md)。

## 可选连接与更新

Codex 本地插件仍是可选功能。已有源码版插件与连接配置可以继续保留；若桌面版使用不同文献库或本机地址，需要核对连接目标。安装包不会自动安装、绑定或更新 Codex 插件，不承诺所有宿主面板能力已完成验证。详见 [Codex 插件](codex-plugin.md)。

本版不提供自动更新。下载新版并替换“应用程序”中的旧应用即可；安装和更新不移动文献库。普通阅读、检索、批注和笔记在本机处理，可选翻译仍需用户主动调用所配置的服务。应用不自动搬迁文献库，没有 OCR 或云同步。

## 构建与发布

维护者在 Apple Silicon Mac 上使用仓库指定的 Node.js 24：

```sh
npm ci
npx playwright install chromium
npm run check
npm run test:desktop
PAPERDESK_ACCEPTANCE_DIR=.local/beta1-verification/source-release npm run test:desktop:reliability
node scripts/test-vault-desktop.mjs
npm run desktop:dist
npm run test:desktop -- --packaged release/mac-arm64/Paperdesk.app
PAPERDESK_ACCEPTANCE_DIR=.local/beta1-verification/packaged-release npm run test:desktop:reliability -- --packaged release/mac-arm64/Paperdesk.app
node scripts/test-vault-desktop.mjs --packaged release/mac-arm64/Paperdesk.app
npm run browser:dist
node scripts/test-browser-release.mjs --archive release/Paperdesk-1.2.0-beta.2-browser.zip
npm run release:checksums
```

`npm run desktop` 用于从源码启动桌面窗口；`npm run desktop:pack` 只生成可用于检查的 `.app`；`npm run desktop:dist` 在 `release/` 生成 `.app`、DMG 和 ZIP。原创图标源为 `desktop/icon.svg`，生成的 PNG、ICNS 位于忽略的 `.local/desktop-assets/`。生产依赖随应用打包，开发依赖不进入安装包。

发布前须用隔离文献库检查安装包启动、PDF 导入及渲染、笔记和批注保存、退出与重开，并对源码和打包应用运行四项可靠性回归、Obsidian 原位／外部导入及书签流程。DMG 还需挂载、复制应用到隔离安装目录后实际启动检查，浏览器 ZIP 需在独立解压目录安装依赖、停止和重启读回；同时确认包内不存在私人资料。不要使用正式文献库做自动回归。测试库和配置默认放临时目录并清理，需要留证时才指定 `.local/` 内专用证据目录，保留一份当前摘要和必要截图，不累计多轮合成库和安装副本。安装包检查通过后，macOS 的 `release:checksums` 为当前 DMG／ZIP 写入 `SHA256SUMS`；Windows 为当前 portable EXE 写入 `SHA256SUMS-win`。两者均不收录应用目录或更新元数据。

GitHub Actions 的 **Desktop preview release** 工作流分别在 `macos-15` arm64 和 `windows-latest` x64 上执行。手动运行默认只检查和构建；在 `main` 上启用 `create_draft` 时，所有验证通过后才为本次提交创建版本标签和发布草稿。Mac 验收 DMG 挂载后复制出的应用，Windows 验收 ZIP 解压出的应用，两者均使用隔离文献库并检查包内私人资料。已有 `v<版本>` 标签也可触发相同流程，标签必须匹配 `package.json`。两个平台全部检查通过后，统一下载产物并核对校验值，再创建 **Draft / Prerelease**。任一平台失败时不创建发布草稿；现有标签不移动，同名 Release 不覆盖。维护者核对产物和说明后发布草稿。

另行提供带构建界面的 [本机浏览器 ZIP](browser-release.md)，需要 Node.js 24+。项目已按用户选择采用 [MIT 许可证](../LICENSE)；历史已发布桌面包的许可证作为 Release 的独立附件提供，后续桌面构建包含许可证正文。

源码、安装包、DMG 安装、浏览器包及匿名下载校验分别记录，本版范围见 [变更记录](history/1.2.0-beta.1.md)。工作流配置存在不代表远端检查已通过；以本次运行结果及实际安装包验收为准。真实 Codex 宿主中的完整插件流程需单独验收；多个窗口的阅读位置也没有全局排序，知识库同步不提供全局锁。版本号在 `package.json` 与锁文件中保持一致，不自动添加许可证或公开仓库。
