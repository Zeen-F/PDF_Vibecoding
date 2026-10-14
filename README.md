# 纸间 Paperdesk

**Vibe Coding 项目 · 预览版**

一个本地 PDF 阅读与笔记工具：划重点、批注图表、记录想法，并保留引文和页码，方便回到原文核对。可以使用独立文献库，也可以直接阅读 Obsidian 知识库中的 PDF。

项目通过与 AI 对话、反复试用和修改持续开发。普通阅读和笔记无需配置 AI；翻译接口与 Codex 插件按需启用。

[下载预览版](#下载与使用) · [第一次使用](#第一次使用) · [数据与备份](#数据与备份) · [反馈问题](https://github.com/Zeen-F/PDF_Vibecoding/issues)

## 下载与使用

当前公开预览版为 [**1.2.0-beta.2**](https://github.com/Zeen-F/PDF_Vibecoding/releases/tag/v1.2.0-beta.2)，尚非稳定版。**Windows 和 Mac 桌面包自带运行环境，无需安装 Node.js。**

| 平台 | 下载 | 打开方式 |
| --- | --- | --- |
| Windows 10/11 x64 | [Windows ZIP](https://github.com/Zeen-F/PDF_Vibecoding/releases/download/v1.2.0-beta.2/Paperdesk-1.2.0-beta.2-win-x64.zip) | 完整解压到可写目录，双击 `Paperdesk.exe`；保留整套解压文件 |
| macOS · Apple Silicon（M 系列） | [Mac DMG](https://github.com/Zeen-F/PDF_Vibecoding/releases/download/v1.2.0-beta.2/Paperdesk-1.2.0-beta.2-mac-arm64.dmg) | 将 Paperdesk 拖入“应用程序”后打开 |
| 本机浏览器版 | [浏览器 ZIP](https://github.com/Zeen-F/PDF_Vibecoding/releases/download/v1.2.0-beta.2/Paperdesk-1.2.0-beta.2-browser.zip) | 需要 Node.js 24+，按[下方步骤](#启动浏览器版)运行 |

Windows 包未签名；Mac 包未经过 Apple 开发者签名或公证。首次运行请核对来源并遵循系统提示，具体见[桌面安装说明](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/desktop-release.md)。[Release 页面](https://github.com/Zeen-F/PDF_Vibecoding/releases/tag/v1.2.0-beta.2)提供各平台的 SHA-256 校验文件与验证范围。

目前没有自动更新，也未提供 Intel Mac、Windows ARM 或 Linux 桌面包。升级前请正常退出并[备份完整资料](#数据与备份)。

> **版本提醒：** 上述下载包不包含“发送到知识工作台”。该功能已进入源码（当前 main 标记为 1.2.0-beta.4）；已有 Windows beta.3 本机验收记录，但这些后续版本尚无公开下载包。详见[两款工具如何配合](#与知识工作台配合)。

## 第一次使用

1. **打开一篇 PDF。** 启动桌面版，点击导入或拖入文件。已有 Obsidian 知识库时，也可以在“文件 → 打开 Obsidian 仓库…”选择根目录，再从侧边栏打开已有 PDF。
2. **留下阅读记录。** 选中文字，核对引文后保存高亮或评论；扫描件、图表和公式可以框选区域并写评论。
3. **写下自己的理解。** 在笔记区自由记录，等待保存完成；需要继续整理时，导出包含笔记、引文、评论和页码的 Markdown。
4. **下次接着读。** 给重要页面添加书签。Mac 关闭窗口后可从 Dock 重开，完全退出使用 ⌘Q；Windows 关闭窗口会等待保存后退出。

建议先用一份非重要 PDF 熟悉流程，再连接正式文献库。Obsidian 的文件位置、编辑边界和冲突处理见[仓库使用说明](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/obsidian-vault.md)。

## 可以做什么

以下能力以公开版 **1.2.0-beta.2** 为准，桌面版与本机浏览器版共用阅读功能。

- **阅读与定位：** 分页或连续阅读、单页及多页布局、缩放、章节目录、个人页面书签；检索可提取的 PDF 文字、笔记和批注并跳到对应页。
- **高亮与批注：** 文字高亮、引文评论、图表或扫描件区域批注；保存前可核对选区。
- **整理与写作：** PDF 导入去重、单层文件夹分类、Markdown 笔记与导出。
- **接入 Obsidian：** 原位阅读库内 PDF，笔记与批注保存在知识库 Markdown；笔记正文可在两边错开编辑。
- **按需扩展：** 森林、暖砂、雾蓝、夜读四套皮肤；可选 API 翻译与 Codex 插件。

## 数据与备份

普通阅读、搜索、笔记和 PDF 渲染在本机处理，不调用外部 AI 服务；安装包不包含个人文献或密钥。本机阅读服务只监听 `127.0.0.1`。

| 使用方式 | 资料保存在哪里 |
| --- | --- |
| 独立文献库 | 桌面版默认保存在应用之外，也可打开已有完整文献库；替换应用不会自动搬迁资料 |
| Obsidian 仓库 | 已有 PDF 原位读取；外部导入副本放入 `Paperdesk/PDFs/`，笔记、批注和书签放入 `Paperdesk/Notes/`；索引、翻译设置与恢复资料留在库外 |
| 浏览器版 | 默认使用解压目录的 `data/`，可通过 `PAPERDESK_DATA_DIR` 指定固定位置；源码开发模式使用隔离的 `.local/dev-data/` |

**更新或回退前，先正常退出应用和相关服务，再备份完整资料。**

- 独立库：备份整个文献库，包括数据库、`pdfs/` 和已有翻译数据库；运行中不能只复制主数据库。翻译数据库可能包含 API 凭据，请勿公开上传或提交 Git。
- Obsidian：备份完整知识库及库外恢复资料、翻译设置。保留源 PDF 的位置、名称、内容，以及 Paperdesk Markdown 的生成区和管理状态；标题、批注、书签和分类请在 Paperdesk 修改。
- 当前公开版使用 schema 5 与 v3 Markdown。旧库升级和回退请按[桌面升级说明](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/desktop-release.md#升级到-120-beta1)操作；自动数据库备份不能替代 PDF、Markdown 和设置的完整备份。
- 保存失败或冲突时，保留窗口与草稿，核对实际保存结果后再继续。正常退出会等待保存，但强制退出、断电或清理浏览器存储仍可能丢失未提交内容。详细机制见[保存与恢复记录](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/history/1.1.0-beta.5.md)。

### 可选 AI：由你决定共享什么

- **翻译：** 配置自己的接口后，只有主动点击才将当次选中文字发送给该接口。见[翻译设置](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/translation.md)。
- **Codex：** 另行安装本机插件，明确共享选区后，在当前 Work／Codex 对话中提问；主动共享的内容会进入模型请求。见[插件说明](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/codex-plugin.md)。

普通阅读不要求连接这些服务。涉及未公开论文或敏感资料时，先核对所选内容和服务方的数据政策。

## 与知识工作台配合

[知识工作台](https://github.com/Zeen-F/knowledge-workbench)负责收集材料、写作、知识卡与 AI 草稿审核；纸间负责 PDF 阅读、选区与批注。两款工具可以分别使用。

| 版本范围 | 配合方式 |
| --- | --- |
| 纸间公开版 `1.2.0-beta.2` | 可使用 Obsidian 仓库与 Markdown 导出；**不含**“发送到知识工作台” |
| 纸间当前源码 `1.2.0-beta.4` | 同一 Obsidian 库中，将选中文字、区域原图、想法和实际页码保存为交换包，供工作台离线导入与来源回查；尚未公开发布 |

发送交换包本身不调用模型。当前源码接口见[联动说明](docs/knowledge-workbench.md)，Windows beta.4 的开发与验收见 [PR #23](https://github.com/Zeen-F/PDF_Vibecoding/pull/23)。较早的[Windows beta.3 记录](docs/history/1.2.0-beta.3.md)保留为历史；本机 Windows 结果不代表 Mac 包或所有 Codex 宿主已验证。

## 目前的限制

- 没有 OCR：扫描件可以阅读、记笔记和框选批注，不能直接搜索或划选图片中的文字。
- 复杂排版的选文和目录识别可能不准确，保存引文前请核对预览。
- 暂不支持加密／权限受限 PDF、PDF 内嵌批注编辑、内置云同步或多人协作。
- 同一文献建议只在一个窗口、一个设备编辑；阅读位置没有跨窗口全局排序，Obsidian 文件联动也不保证多设备同时写入一致性。
- 真实翻译服务、Codex 宿主完整对话、断电恢复等，不由合成资料自动测试代替。各版本验证边界以对应 Release 为准。

## 启动浏览器版

安装 **Node.js 24+**，解压上方浏览器 ZIP，进入解压出的目录：

```sh
npm ci --omit=dev
npm start
```

Windows PowerShell 使用 `npm.cmd` 替代 `npm`。在浏览器打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)，保持终端运行；按 Control+C 停止服务。

ZIP 已包含构建好的界面，无需重新构建；详细步骤在包内 `START-HERE.md`。安装依赖需要联网。浏览器 ZIP 的干净安装验收在 macOS 执行，Windows 浏览器源码入口另有回归，具体见[浏览器版说明](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.2.0-beta.2/docs/browser-release.md)。

## 从源码运行与开发

需要 **Git 与 Node.js 24+**。要运行与公开下载包对应的源码：

```sh
git clone --branch v1.2.0-beta.2 https://github.com/Zeen-F/PDF_Vibecoding.git
cd PDF_Vibecoding
npm ci
npm run build
npm start
```

Windows PowerShell 将上述 `npm` 命令改为 `npm.cmd`。运行后打开终端显示的本机地址。已安装依赖并构建后，也可使用 `启动纸间.cmd`（Windows）或 `启动纸间.command`（Mac）；更新源码后请重新构建。

要参与当前开发，克隆 `main` 后新建开发分支，按[开发指南](docs/development.md)操作；main 可能包含尚未发布的功能。开发与测试使用隔离合成文献库。

- [Windows 使用与开发](docs/windows.md) · [阅读布局](docs/reader-display.md)
- [仓库与工作区安排](docs/repository-layout.md) · [贡献约定](CONTRIBUTING.md)
- [提交问题或建议](https://github.com/Zeen-F/PDF_Vibecoding/issues)

## 为什么做纸间

我是软件开发小白，这个软件是通过和 AI 对话、反复试用和修改，**vibe coding** 出来的。最初只是想给自己做一个方便读 PDF、划重点和记笔记的工具，于是有了「纸间」。

现在把它开源，也欢迎大家反馈问题、提建议或提交改进。项目还在持续完善，目前发布的是预览版。

## 联系作者

- 微信：a1152017529
- QQ：1152017529

使用问题和建议也欢迎通过 [GitHub Issues](https://github.com/Zeen-F/PDF_Vibecoding/issues)反馈，方便追踪。

## 许可证

本项目采用 [MIT License](LICENSE)。第三方依赖保留各自的许可证。

