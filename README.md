# 纸间 Paperdesk

在本机阅读 PDF、划重点、记笔记，并把选中的证据带回写作。支持 Windows 桌面、Apple Silicon Mac 桌面和本机浏览器；可以使用独立文献库，也可以连接已有 Obsidian 知识库。

我是软件开发小白，这个软件是通过和 AI 对话、反复试用和修改，**vibecoding（vibe coding）** 出来的。最初只是想给自己做一个方便读 PDF、划重点和记笔记的工具，于是有了「纸间」。目前仍是预览版，欢迎反馈问题、提建议或提交改进。

## 下载、启动与升级

本次版本为 **1.2.0-beta.5**，包含下文的阅读改进与可选山岚 V2 外观。[下载版本与校验值](https://github.com/Zeen-F/PDF_Vibecoding/releases/tag/v1.2.0-beta.5) 以 Release 页面实际提供的文件为准；源码更新不会自动升级旧安装包。

| 入口 | 使用方法 |
| --- | --- |
| [Windows x64 ZIP](https://github.com/Zeen-F/PDF_Vibecoding/releases/download/v1.2.0-beta.5/Paperdesk-1.2.0-beta.5-win-x64.zip) | 完整解压到固定应用目录，打开 `Paperdesk.exe`；无需 Node.js。整个目录是一套应用，不能只复制 EXE。 |
| [macOS ARM64 DMG](https://github.com/Zeen-F/PDF_Vibecoding/releases/download/v1.2.0-beta.5/Paperdesk-1.2.0-beta.5-mac-arm64.dmg) | 将 Paperdesk 拖入「应用程序」；无需 Node.js。当前预览包尚未经过 Apple 签名或公证。 |
| [本机浏览器 ZIP](https://github.com/Zeen-F/PDF_Vibecoding/releases/download/v1.2.0-beta.5/Paperdesk-1.2.0-beta.5-browser.zip) | 安装 Node.js 24+，在解压目录运行 `npm ci --omit=dev`、`npm start`，打开 `http://127.0.0.1:4317`；PowerShell 使用 `npm.cmd`。 |

升级前保存并正常退出旧应用，备份完整文献库。将新版完整应用目录放到固定位置，再更新原桌面快捷方式的目标和工作目录；不要把临时测试包作为长期入口，也不要覆盖或搬动文献库。没有自动更新。旧插件若占用应用文件，先正常断开连接再升级。

独立库沿用 schema 5；旧格式迁移、回退与 Obsidian Markdown 兼容要求见 [桌面安装与升级](docs/desktop-release.md) 和 [Obsidian 仓库模式](docs/obsidian-vault.md)。数据库自动备份不能替代 PDF、Markdown 和设置的完整备份。Windows 入口、云盘文件下载和目录安排见 [Windows 指南](docs/windows.md)。

## 阅读与记录

| 功能 | 当前源码中的行为 |
| --- | --- |
| PDF 与文献库 | 导入或拖入 PDF，按内容去重；Obsidian 中已有 PDF 原位阅读，保留源文件位置与内容。 |
| 整理和搜索 | 单层文件夹、PDF 可提取文字／笔记／批注搜索，点击结果定位。 |
| 阅读布局 | 左右翻页或上下连续阅读，单页至九页布局、缩放与适合宽度；次要选项集中在显示设置。 |
| 目录与书签 | PDF 目录、文字目录识别与页码校正，以及单独保存的个人页面书签。 |
| 高亮与区域批注 | 选中文字后核对引文并写评论；扫描页、图表和公式可以框选区域。 |
| 笔记与导出 | 单一 Markdown 编辑区、自动／手动保存，导出引文、评论和实际 PDF 页码。 |
| 专注与返回 | 临时收起阅读侧栏并保留笔记编辑区和草稿；来源定位后可返回原页面及窗口内阅读位置。 |
| 弹层与窄窗 | 显示设置和翻译卡支持键盘焦点、Esc 关闭及窄窗口布局。 |

显示设置、专注阅读、来源返回、翻译确认和受权限控制的 MCP 搜索属于本次升级，旧 beta.2 安装包不包含。详细操作见 [阅读布局与来源定位](docs/reader-display.md)。森林、暖砂、雾蓝、夜读四套皮肤不会改变 PDF 原始颜色。

## 山岚 V2 外观

当前源码提供山岚书桌、紧凑书架、仅按标题的快速定位，以及晨间／月下场景。快速定位支持 ↑↓、Enter、Esc，关闭后焦点返回入口；文献栏边界可以拖动，也可用左右方向键调宽、Home／End 调到边界、双击恢复默认。密度与场景仅在本次页面内生效，不改写已保存的四套主题。

- 浏览器：在当前本机服务地址后加 `/?visual=shanlan`。去掉该参数即回到原外观。
- 源码桌面：构建后运行 `npx.cmd electron . --shanlan-daily`；已有完整桌面包可运行 `Paperdesk.exe --shanlan-daily`。此模式沿用原配置及文献库，使用前正常退出已有窗口。
- 隔离预览：使用 `--shanlan-preview`，可附加 `--preview-profile=完整目录路径` 指定独立配置目录；默认使用单独的预览配置。预览不会迁移日常文献库，测试时只导入合成资料。

新外观自 beta.5 提供，默认入口保留原外观。`npm.cmd run check` 包含合成资料的山岚界面回归；浏览器测试不代表真实模型、Codex 宿主或各平台安装器均已验收。

## 划词与手动选段翻译

1. 在带文字层的 PDF 中手动选择一个词、一句话或一段。
2. 打开翻译预览，核对原文、服务、接口和目标语言。
3. 点击“确认发送选文”。每次只发送这次预览中的选区，译文不自动写入笔记。
4. 下一段重新手动选择并确认；切换语言、修改服务配置或失败后重试，也需要重新确认。上一版译文保留到新译文成功。

**不提供整页翻译，不自动扩展选区或连续发送相邻段落。** 扫描图片暂不做 OCR，区域截图不能直接使用文字翻译。

软件内 API 翻译是可选项，支持百度、Azure、DeepL 和 OpenAI 兼容接口。填写自己的服务参数后才能使用，费用与可用额度由服务商决定；保存配置不代表凭据已验证。“测试翻译”会发送固定短句并可能使用额度，普通阅读、打开预览和切换语言不会发送选文。配置、缓存、预算和失败处理见 [翻译说明](docs/translation.md)。

也可以通过下方 Codex 插件明确共享选区，在当前对话中要求翻译或讨论；它使用当前 Codex 会话，与软件内独立翻译 API 分开。

## Codex 插件

插件连接本机 Paperdesk 服务。阅读器中的普通浏览不自动共享全文；核对选区后再点“交给 Codex”，需要回答时再发送问题。AI 回答留在当前对话，只有明确要求记录时才追加笔记；未保存草稿或版本冲突会阻止覆盖。

源码版需要 Node.js 24+、项目依赖和支持本地插件的 Codex。下面的命令对应源码浏览器服务：先运行 `npm.cmd run build`、`npm.cmd start`，核对打开的是预期文献库；保持服务运行，在另一个终端执行：

```powershell
npm.cmd run plugin:install
```

命令会准备本机绑定、注册本地 marketplace 并安装插件。安装后在 Codex 新会话启用“纸间 Paperdesk”，说“打开纸间阅读器”，核对返回的资料库身份。已有绑定不一致时先确认目标库，不要覆盖配置。移动运行时目录或升级桌面包后需要重新核对绑定；自定义端口不能照抄默认的 4317。完整安装和绑定步骤见 [Codex 插件说明](docs/codex-plugin.md)。

MCP 文献搜索默认只搜索标题。正文、笔记和批注检索需要本机显式授权，授权包含内容范围、有效期及预算；不因一句“搜索文献”自动开放整个资料库。主动共享或检索返回给 Codex 的内容可能进入模型请求。

插件安装、MCP 调用成功和宿主实际显示内嵌面板是不同检查。当前 Windows 验证包含真实 MCP 调用及现有 Codex 会话的合成选文翻译；**当前宿主内嵌面板的视觉验收仍未完成**。独立翻译 API 未做真实服务账户验收，模拟测试不能替代它。

## 从阅读证据到科研笔记

与 [知识工作台](https://github.com/Zeen-F/knowledge-workbench) 连接同一个 Obsidian 库后，在纸间选中文字或区域，点击“发送到知识库”，核对实际 PDF 页并补充想法。保存的是这次选区、来源和可选原图，不会自动调用模型，也不修改原 PDF。

在工作台收集箱筛选材料、预览来源并选择参考笔记，再确认共享给 Codex 或自己的模型 API。生成结果进入待审草稿，结合固定的原文快照核对后再保存；原文、个人假设、AI 推断和待验证项应分别保留。来源链接可返回原 PDF 页和选区，文件变化或丢失时会提示核对，不会静默替换来源。

该交换功能属于当前源码，beta.2 下载包不包含。接口、离线导入和返回规则见 [知识工作台交换说明](docs/knowledge-workbench.md)。

## 数据、保存与恢复

- 普通阅读、搜索、批注与笔记在本机处理，不需要翻译密钥或 Codex 插件。
- Obsidian 模式下，已有 PDF 保持原位；外部导入副本保存在 `Paperdesk/PDFs/`，笔记、批注和页面书签在 `Paperdesk/Notes/`。正文可在两边编辑，受管理的标题、批注和书签在纸间修改。
- 桌面文献库与应用目录分开；源码浏览器版默认用 `data/`，开发模式用隔离的 `.local/dev-data/`。索引、翻译设置及恢复资料不作为正式笔记写进知识库。
- 保存失败或版本冲突会保留输入并要求核对；正常桌面关闭等待待保存内容。评论草稿属于当前浏览器／桌面配置，不能替代文献库备份。
- 跨盘保存保留可恢复的原文件，并检查副本和并发修改。云盘 PDF 短暂改变元数据时有界重读，持续变化或校验不一致仍拒绝继续。详见 [跨盘保存与成品验证](docs/vault-cross-volume-recovery.md)。

备份前正常停止服务；独立库备份完整数据库及 PDF、翻译数据，不能在运行中只复制数据库主文件。Obsidian 模式应备份关联源 PDF、Paperdesk 管理文件及库外设置／恢复资料。含凭据的配置与数据库不要上传或提交 Git。强制退出、断电或清理浏览器存储不保证尚未提交的内容可恢复。

## 从源码运行与检查

需要 Node.js 24+。首次获取源码后在项目目录运行；已有工作区直接使用原目录。以下为 Windows PowerShell 命令，macOS 使用 `npm` / `npx`：

```powershell
git clone https://github.com/Zeen-F/PDF_Vibecoding.git
cd PDF_Vibecoding
npm.cmd ci
npm.cmd run desktop
```

本机浏览器入口：`npm.cmd run build` 后运行 `npm.cmd start`，打开 `http://127.0.0.1:4317`。也可双击 `启动纸间.cmd`（macOS 为 `启动纸间.command`）。更新源码后重新构建；关掉网页不会停止服务，终端按 Ctrl+C 正常停止。服务仅监听本机地址。

```powershell
npx.cmd playwright install chromium
npm.cmd run check
npm.cmd run desktop:pack:win
npm.cmd run test:desktop -- --packaged release/win-unpacked/Paperdesk.exe
```

Windows 目录包入口为 `release/win-unpacked/Paperdesk.exe`。打包需要本目录中的完整物理依赖，不能用 Junction／symlink 根 `node_modules`；打包检查会核对生产依赖和 MCP 面板资源。macOS 打包入口为 `npm run desktop:pack`。安装依赖需要联网；测试使用合成资料，详见 [开发指南](docs/development.md)。

## 限制与反馈

- 暂无 OCR、PDF 内嵌批注编辑、内置云同步或多人协作；不支持加密／权限受限 PDF。
- 双栏、脚注、公式及复杂文字层可能影响选文顺序，发送或保存引文前核对预览。100% 正常字号的 Windows 鼠标选文已验证；约 6px 微小字号的精确选文未验证。
- 同一文献建议只在一个窗口编辑；没有多设备并发写入的一致性保证。Windows 桌面验收不能替代原生 macOS 验收，CI 也不等于真实模型或宿主面板验收。

[反馈问题](https://github.com/Zeen-F/PDF_Vibecoding/issues) · [贡献约定](CONTRIBUTING.md) · [仓库安排](docs/repository-layout.md)

作者联系方式：**微信 a1152017529 · QQ 1152017529**。

本项目采用 [MIT License](LICENSE)，第三方依赖保留各自许可证。
