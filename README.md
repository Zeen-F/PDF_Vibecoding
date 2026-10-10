# 纸间 Paperdesk

Windows 工作区的使用、开发和清理说明见 [Windows 指南](docs/windows.md)。已安装依赖并构建后，可以双击根目录 `启动纸间.cmd` 打开本机浏览器版；Windows 桌面目录包使用 `release/win-unpacked/Paperdesk.exe`。

我是软件开发小白，这个软件是通过和 AI 对话、反复试用和修改，**vibe coding** 出来的。最初只是想给自己做一个方便读 PDF、划重点和记笔记的工具，于是有了「纸间」。

现在把它开源，也欢迎大家反馈问题、提建议或提交改进。项目还在持续完善，目前发布的是预览版。

## 下载与使用

最新预览版本：[**1.2.0-beta.2 · GitHub Release**](https://github.com/Zeen-F/PDF_Vibecoding/releases/tag/v1.2.0-beta.2)。

| 版本 | 适合谁 | 使用方式 |
| --- | --- | --- |
| Windows 桌面版 | 使用 Windows 10/11 x64，希望直接打开软件 | 下载 [Windows ZIP](https://github.com/Zeen-F/PDF_Vibecoding/releases/download/v1.2.0-beta.2/Paperdesk-1.2.0-beta.2-win-x64.zip)，完整解压后打开 Paperdesk.exe；无需安装 Node.js |
| macOS 桌面版 | 使用 M 系列 Mac，希望直接打开软件 | 下载 [macOS DMG](https://github.com/Zeen-F/PDF_Vibecoding/releases/download/v1.2.0-beta.2/Paperdesk-1.2.0-beta.2-mac-arm64.dmg)，将 Paperdesk 拖入「应用程序」；无需安装 Node.js |
| 本机浏览器版 | 希望通过本机端口在浏览器里使用 | 下载 [浏览器版 ZIP](https://github.com/Zeen-F/PDF_Vibecoding/releases/download/v1.2.0-beta.2/Paperdesk-1.2.0-beta.2-browser.zip)，安装 Node.js 24+ 后启动，打开 `http://127.0.0.1:4317` |

桌面版尚未经过 Apple 签名或公证；首次打开如果被 macOS 阻止，可在「系统设置 → 隐私与安全性」中允许。Obsidian 仓库、页面书签和升级注意事项见 [本版变更记录](docs/history/1.2.0-beta.2.md)。安装及已有文献库的使用方式见 [桌面版说明](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/desktop-release.md)。

## 可以做什么

以下功能以 **1.2.0-beta.2** 为准，桌面版和本机浏览器版使用同一套阅读功能。

| 功能 | 说明 |
| --- | --- |
| 导入 PDF | 点击选择或拖入文件；相同内容自动去重，同名但内容不同的文件可以共存 |
| Obsidian 仓库 | 侧边栏显示知识库已有 PDF，点击原位阅读；也可导入外部 PDF，笔记与批注保存在知识库 Markdown |
| 整理文献 | 单层文件夹分类，支持拖动或选择移动；删除分类会保留里面的文献 |
| 搜索 | 检索 PDF 中可提取的文字、笔记和批注，点击结果跳到对应页 |
| 多种阅读布局 | 左右翻页、上下连续阅读；单页、双页、四页、六页、九页布局，以及缩放与适合宽度 |
| 章节目录 | 使用 PDF 书签；没有书签时尝试识别文字目录页，也可以手动校正页码偏移 |
| 个人页面书签 | 添加当前实际 PDF 页、改名、删除和跳转，退出与重开后保留；与 PDF 自带目录分别显示 |
| 文字高亮与评论 | 选中文字、核对引文后保存高亮和评论，支持修改颜色与评论 |
| 区域批注 | 在扫描件、图表或公式附近框选区域并写评论 |
| 笔记 | 一个编辑区自由记录，中英文都可以写，支持 Markdown 文本、自动保存和手动保存 |
| Markdown 导出 | 导出笔记、引文、评论和页码，方便继续在 Obsidian 等工具中使用 |
| 四套阅读皮肤 | 森林、暖砂、雾蓝、夜读；界面换色时保留 PDF 原始颜色 |
| 可选 API 翻译 | 配置自己的翻译接口与密钥后，主动翻译文字选区；译文显示在阅读器中 |
| 可选 Codex 插件 | 明确共享选区后，在当前 Work／Codex 对话中提问；需要另外安装本机插件 |

## 数据与备份

源码另有待发布的[发送到知识工作台](docs/knowledge-workbench.md)功能：在同一 Obsidian 库内保存选中文字、区域原图、想法与实际页码，供工作台离线导入和来源回查。上方 `1.2.0-beta.2` 下载包尚不包含此功能。

可以使用独立文献库或 Obsidian 仓库。普通阅读和编辑不调用外部 AI 服务，安装包也不包含个人文献。

**Obsidian 仓库模式：** 侧边栏自动显示知识库已有 PDF，点击即可原位阅读和批注；外部文件的导入副本保存在知识库的 `Paperdesk/PDFs/`，外部原文件保留。笔记、批注和个人页面书签保存在 `Paperdesk/Notes/`，正文两边可编辑；标题、批注、书签和分类在 Paperdesk 修改。索引、翻译设置和恢复资料留在知识库之外。冲突暂停自动保存，副本实际保存成功后才确认保留。规则、冲突处理和备份方法见 [Obsidian 仓库模式](docs/obsidian-vault.md)。

- 桌面版默认使用应用之外的独立文献库，也会记住所选位置；「文件 → 打开已有文献库…」接受完整的 schema 4／5 库；「打开 Obsidian 仓库…」选择已有知识库根目录。
- 源码浏览器版默认使用项目内的 `data/`；开发模式使用隔离的 `.local/dev-data/`。
- 翻译只在主动点击时，将当次选中的文字发送到你配置的接口。主动交给 Codex 的内容会进入模型请求。
- 独立文献库：正常停止应用或服务后备份完整目录，包括数据库、`pdfs/` 及已有翻译数据库；运行中不能只复制主数据库。
- Obsidian 仓库：正常退出后备份完整 Paperdesk 管理目录和所有关联的源 PDF，保留库外恢复资料及翻译设置；备份整个知识库更方便。已有源 PDF 的位置和内容不改写。

**升级到 1.2.0-beta.2 前请正常退出并备份完整资料。** 本版沿用 **schema 5** 与个人页面书签格式；程序在修改旧数据库结构前创建并读回检查 SQLite 一致性备份，包含已提交的 WAL 内容。备份失败会停止升级，数据库迁移在事务中完成。自动数据库备份不能替代 PDF、Markdown 和翻译设置的完整备份。

- 默认／已记住库在启动时升级；菜单新选择完整 schema 4 库先只读校验，再在启动时备份并升级。schema 3 或更早的库须先通过本版浏览器／源码服务升级，详见 [升级步骤](docs/desktop-release.md#升级到-120-beta1)。
- Obsidian 的旧 v1／v2 文献 Markdown 继续可读，成功保存时写入支持书签的 v3 完整状态，保留原位或导入来源。旧程序不能读取新增格式。
- 回退时正常退出新版，恢复升级前完整备份，再运行旧版；不要手工删表或降低数据库版本号。beta.5 的 schema 4 与保存可靠性变更保留在 [历史记录](docs/history/1.1.0-beta.5.md)。

## 保存与恢复

- **评论草稿：** 切换笔记／批注、文献或刷新后，可恢复原文献的评论、页码和引文／区域；确认保存成功后才清除本次提交的草稿。各窗口独立保留草稿；保存失败或版本冲突时保留输入，恢复的评论不会自动附到后来选择的内容。
- **批注保存：** 相关数据库写入一起成功或回滚。新增请求在响应丢失后以原请求重试，避免重复批注；有效请求记录保留 30 天，容量满时拒绝新请求，不提前丢弃有效记录。超过期限仍不确定的旧请求，应先核对文献中已保存的批注。
- **启动检查：** 复用本机服务前核对文献库、产品版本、API 版本、启动协议与健康状态，避免打开错误的库或不兼容服务。
- **阅读位置：** 快速翻页按文献合并并顺序保存；切文献和桌面正常关闭前等待最后一次写入。同一窗口的旧序号不能覆盖较新的页码，保存失败后可以恢复并重新确认。

草稿只保存在当前浏览器／桌面配置中，不能替代文献库备份。浏览器存储不可用或容量不足时，请保留当前窗口并处理保存问题。删除结果不确定时也保留评论草稿，应重新打开文献核对；通信失败不表示批注尚未删除。浏览器强制退出、断电或清理浏览器存储，无法保证最后一次尚未提交的内容或页码已经保存。

## 启动浏览器版 ZIP

解压浏览器版 ZIP，进入解压出的目录。安装 **Node.js 24+** 后执行：

```sh
npm ci --omit=dev
npm start
```

ZIP 已包含构建好的界面，不需要重新构建。打开 **http://127.0.0.1:4317** 即可使用；终端保持运行，按 Control+C 停止服务。详细说明在包内的 `START-HERE.md`。浏览器 ZIP 的干净安装验收在 macOS 执行，Windows 浏览器源码入口另经完整回归；Windows 桌面使用上方的 ZIP。

文献库默认在解压目录的 `data/` 中，更新前请先停止服务并备份整个文献库；也可通过 `PAPERDESK_DATA_DIR` 指定固定位置。

## 从源码启动本机浏览器版

使用本版源码时，请检出对应版本标签：

```sh
git clone --branch v1.2.0-beta.2 https://github.com/Zeen-F/PDF_Vibecoding.git
cd PDF_Vibecoding
npm ci
npm run build
npm start
```

需要 **Node.js 24+**。启动后在浏览器打开 **http://127.0.0.1:4317**；终端保持运行，按 Control+C 停止服务。Mac 也可在构建完成后使用项目里的 `启动纸间.command`。启动器只在缺少构建产物时自动构建，更新源码后请重新运行 `npm run build`；端口被不同库或不兼容服务占用时会提示并停止启动，请先核对原服务。

服务仅监听本机 `127.0.0.1`。安装依赖需要联网；准备完成后的普通阅读、搜索、笔记和 PDF 渲染在本机处理。

## 目前的限制

- 扫描件可以阅读、记笔记和框选批注；目前没有 OCR，不能直接搜索或划选图片中的文字。
- 复杂排版的选文和目录识别可能不准确，保存引文前请核对预览。
- 暂不支持加密／权限受限 PDF、PDF 内嵌批注编辑、云同步和多人协作。
- 桌面发布包面向 Apple Silicon Mac 与 Windows x64；Windows 使用和开发说明见 [Windows 指南](docs/windows.md)。没有自动更新，其他桌面架构尚未验证。
- 多个窗口之间的阅读位置没有全局排序，建议同一文献只在一个窗口编辑。Obsidian 文件联动不保证多设备同时写入一致性；真实 Codex 宿主中的完整插件流程需单独验收。

## 开发与反馈

最新发布源码的开发、检查、插件与翻译说明：

- [开发指南](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/development.md)
- [阅读布局说明](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/reader-display.md)
- [翻译设置](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/translation.md)
- [Codex 插件](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/codex-plugin.md)
- [反馈问题](https://github.com/Zeen-F/PDF_Vibecoding/issues) · [贡献约定](CONTRIBUTING.md)

## 文件安排

源码放在 `src/`、`server/` 等目录；说明集中在 `docs/`，测试放在 `tests/`。本机安装包放在 `release/`，验收材料集中在忽略的 `.local/`；文献库不会进入 Git。详细目录与本机整理规则见 [仓库与工作区安排](docs/repository-layout.md)。

## 许可证

本项目采用 [MIT License](LICENSE)。第三方依赖保留各自的许可证。
