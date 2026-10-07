# 纸间 Paperdesk

我是软件开发小白，这个软件是通过和 AI 对话、反复试用和修改，**vibe coding** 出来的。最初只是想给自己做一个方便读 PDF、划重点和记笔记的工具，于是有了「纸间」。

现在把它开源，也欢迎大家反馈问题、提建议或提交改进。项目还在持续完善，目前发布的是预览版。

## 下载与使用

最新版本：[**1.1.0-beta.4 · GitHub Release**](https://github.com/Zeen-F/PDF_Vibecoding/releases/tag/v1.1.0-beta.4)。

| 版本 | 适合谁 | 使用方式 |
| --- | --- | --- |
| macOS 桌面版 | 使用 M 系列 Mac，希望直接打开软件 | 下载 [macOS DMG](https://github.com/Zeen-F/PDF_Vibecoding/releases/download/v1.1.0-beta.4/Paperdesk-1.1.0-beta.4-mac-arm64.dmg)，将 Paperdesk 拖入「应用程序」；无需安装 Node.js |
| 本机浏览器版 | 希望通过本机端口在浏览器里使用 | 下载 [浏览器版 ZIP](https://github.com/Zeen-F/PDF_Vibecoding/releases/download/v1.1.0-beta.4/Paperdesk-1.1.0-beta.4-browser.zip)，安装 Node.js 24+ 后启动，打开 `http://127.0.0.1:4317` |

桌面版尚未经过 Apple 签名或公证；首次打开如果被 macOS 阻止，可在「系统设置 → 隐私与安全性」中允许。安装及已有文献库的使用方式见 [桌面版说明](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.1.0-beta.4/docs/desktop-release.md)。

## 可以做什么

以下功能以 **1.1.0-beta.4** 为准，桌面版和本机浏览器版使用同一套阅读功能。

| 功能 | 说明 |
| --- | --- |
| 导入 PDF | 点击选择或拖入文件；相同内容自动去重，同名但内容不同的文件可以共存 |
| 整理文献 | 单层文件夹分类，支持拖动或选择移动；删除分类会保留里面的文献 |
| 搜索 | 检索 PDF 中可提取的文字、笔记和批注，点击结果跳到对应页 |
| 多种阅读布局 | 左右翻页、上下连续阅读；单页、双页、四页、六页、九页布局，以及缩放与适合宽度 |
| 章节目录 | 使用 PDF 书签；没有书签时尝试识别文字目录页，也可以手动校正页码偏移 |
| 文字高亮与评论 | 选中文字、核对引文后保存高亮和评论，支持修改颜色与评论 |
| 区域批注 | 在扫描件、图表或公式附近框选区域并写评论 |
| 笔记 | 一个编辑区自由记录，中英文都可以写，支持 Markdown 文本、自动保存和手动保存 |
| Markdown 导出 | 导出笔记、引文、评论和页码，方便继续在 Obsidian 等工具中使用 |
| 四套阅读皮肤 | 森林、暖砂、雾蓝、夜读；界面换色时保留 PDF 原始颜色 |
| 可选 API 翻译 | 配置自己的翻译接口与密钥后，主动翻译文字选区；译文显示在阅读器中 |
| 可选 Codex 插件 | 明确共享选区后，在当前 Work／Codex 对话中提问；需要另外安装本机插件 |

## 数据与备份

PDF、索引、笔记与批注保存在本机文献库。普通阅读和编辑不调用外部 AI 服务，安装包也不包含个人文献。

- 桌面版默认使用应用之外的独立文献库，可从「文件 → 打开已有文献库…」选择现有库。
- 源码浏览器版默认使用项目内的 `data/`；开发模式使用隔离的 `.local/dev-data/`。
- 翻译只在主动点击时，将当次选中的文字发送到你配置的接口。主动交给 Codex 的内容会进入模型请求。
- 备份前先正常停止应用或服务，再复制整个文献库目录，包括数据库和 PDF。原始 PDF 不会被批注或笔记覆盖。

## 启动浏览器版 ZIP

解压浏览器版 ZIP，进入解压出的目录。安装 **Node.js 24+** 后执行：

```sh
npm ci --omit=dev
npm start
```

ZIP 已包含构建好的界面，不需要重新构建。打开 **http://127.0.0.1:4317** 即可使用；终端保持运行，按 Control+C 停止服务。详细说明在包内的 `START-HERE.md`。本次验证环境为 macOS，其他系统尚未验证。

文献库默认在解压目录的 `data/` 中，更新前请先停止服务并备份整个文献库；也可通过 `PAPERDESK_DATA_DIR` 指定固定位置。

## 从源码启动本机浏览器版

默认分支保留早期开发源码。想使用上面列出的版本功能，请检出发布标签：

```sh
git clone --branch v1.1.0-beta.4 https://github.com/Zeen-F/PDF_Vibecoding.git
cd PDF_Vibecoding
npm ci
npm run build
npm start
```

需要 **Node.js 24+**。启动后在浏览器打开 **http://127.0.0.1:4317**；终端保持运行，按 Control+C 停止服务。Mac 也可在构建完成后使用项目里的 `启动纸间.command`。

服务仅监听本机 `127.0.0.1`。安装依赖需要联网；准备完成后的普通阅读、搜索、笔记和 PDF 渲染在本机处理。

## 目前的限制

- 扫描件可以阅读、记笔记和框选批注；目前没有 OCR，不能直接搜索或划选图片中的文字。
- 复杂排版的选文和目录识别可能不准确，保存引文前请核对预览。
- 暂不支持加密／权限受限 PDF、PDF 内嵌批注编辑、云同步和多人协作。
- 安装包目前只支持 Apple Silicon Mac，没有自动更新。

## 开发与反馈

最新发布源码的开发、检查、插件与翻译说明：

- [开发指南](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.1.0-beta.4/docs/development.md)
- [阅读布局说明](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.1.0-beta.4/docs/reader-display.md)
- [翻译设置](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.1.0-beta.4/docs/translation.md)
- [Codex 插件](https://github.com/Zeen-F/PDF_Vibecoding/blob/v1.1.0-beta.4/docs/codex-plugin.md)
- [反馈问题](https://github.com/Zeen-F/PDF_Vibecoding/issues) · [贡献约定](CONTRIBUTING.md)

## 许可证

本项目采用 [MIT License](LICENSE)。第三方依赖保留各自的许可证。
