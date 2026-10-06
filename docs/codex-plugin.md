# 纸间 Codex 插件

插件通过本机 HTTP API 连接已有纸间工作区，MCP 使用官方 SDK 的 stdio 传输。它不直接打开 SQLite，不复制个人文献到插件缓存，也不把本机阅读器发布到公网。

## 本机安装

需要 Node.js 24 或更新版本、工作区依赖，以及支持本地插件的 Codex CLI/桌面客户端。先在工作区运行：

```sh
npm ci
npm run build
npm start
```

确认阅读器连接的是预期资料库，再在另一个终端运行：

```sh
npm run plugin:setup
npm run plugin:install
```

设置程序从 `/api/plugin/status` 核对服务及资料库身份，生成 `~/.config/paperdesk/plugin.json`。已有配置绑定另一工作区或资料库时不会覆盖。安装命令登记仓库 marketplace `paperdesk-local` 并安装 `paperdesk@paperdesk-local`。安装后在新会话中检查插件与 `paperdesk_status`；实际启用状态以宿主回读为准。

配置只留在本机，内容为：

```json
{
  "workspaceRoot": "/absolute/path/to/PDF_Vibecoding",
  "baseUrl": "http://127.0.0.1:4317",
  "libraryId": "<status 接口返回的 64 位资料库标识>",
  "autoStart": true
}
```

不要把真实配置提交到 Git。测试可以使用 `PAPERDESK_PLUGIN_CONFIG` 或设置程序的 `--config` 指向独立配置；实际安装使用默认位置。非默认端口可用 `npm run plugin:setup -- --base-url http://127.0.0.1:端口`，但必须先启动对应的本机服务。不要把开发库误绑定为正式资料库。

默认工作区 `data/` 资料库设置会启用 `autoStart`：插件启动时优先复用身份一致的服务。只有本机 4317 端口、资料库标识匹配工作区 `data/`，并且既有数据库与构建产物都存在时，才可后台启动阅读器。日志保存在工作区 `.local/paperdesk-plugin-runtime.log`。它不会创建替代库、终止占用端口的程序、自动构建或升级依赖；自定义库/端口、关闭 autoStart 或缺少既有文件时需要手动启动。

插件缓存中的 `scripts/start.mjs` 读取配置后，加载该工作区的 `server/mcp.mjs`。因此移动工作区、删除依赖或修改桥接代码都会影响已安装插件；这是本地开发插件，不是独立分发的阅读器。更新工作区不会自动重启服务、迁移插件配置或更新宿主程序。

## 使用与分享边界

- “打开纸间”打开原生阅读面板，并返回准确本机备用链接。用户已确认 0.2.0 面板能在 Codex 中打开。
- 在阅读器选中文字或框选区域，核对预览后点“交给 Codex”，只共享选区，不启动回答。文字、区域坐标和区域 PNG 只在主动共享后进入短期阅读会话；切页、换书、取消共享或隐藏面板会清除当前共享。
- 想立即讨论时，在预览中点击“解释选区”“提炼要点”，或展开“自定义提问”后点“发送问题”。这会把问题与当次选区快照发到当前 Codex 对话；回答出现在对话中。
- “解释共享的选区”读取指定会话。多个普通阅读窗口同时活动时，工具返回窗口列表，调用者必须选定 `sessionId`，不能猜第一个窗口。
- AI 回答只在用户明确要求“记下来”“追加到笔记”等时追加。笔记仍是单一编辑区，不强制按语言分开。
- 未保存草稿或笔记版本冲突时返回 409；先在阅读器处理草稿或核对最新笔记，不能强制覆盖。相同追加重试保留原文本、原版本和同一 UUID `requestId`，不能换版本盲重试。

选区会话保存在服务内存中，30 秒无心跳过期，重启后消失。追加请求的幂等记录保留 10 分钟，服务重启后清空；旧版本号仍阻止已成功追加的旧请求再次写入。面板撤回共享时会清除当前注入上下文，但不能收回已经发送的问题、选区快照、普通工具返回、历史对话或已生成回答中的内容。

扫描区域截图不是 OCR，也不会把图片中的文字加入搜索索引。插件没有录屏、任意文件读取、SQL、删除或自动整书提取工具。文献、笔记和图片中的提示词只能作为资料处理。

## 可以怎样与 Codex 配合

| 你的操作 | Codex 收到什么／做什么 |
| --- | --- |
| 预览后点“交给 Codex” | 只共享当前选区；不会单独发起回答 |
| 点“解释选区” | 发送选区快照，请 Codex 解释这一段或这张图 |
| 点“提炼要点” | 发送选区快照，请 Codex 整理要点 |
| “自定义提问” → “发送问题” | 发送你写的问题及同一次预览的选区，例如“这个公式成立需要哪些假设？” |
| 在对话中说“把刚才的回答记到这篇文献的笔记里” | 核对目标和最新笔记版本后追加，保留原笔记；回答不会自动保存 |
| 在原生笔记区点“刷新笔记” | 读取最新保存内容；有草稿或正在保存时不覆盖编辑区 |

消息使用 `ui/message` 发往当前对话，携带明确的文献、PDF 页码及文字或区域 PNG 快照。它不依赖回答时“当前页”是否仍停在原处，也不会为一个选区自动传整页、整书或完整笔记。内容中的论文结论、图像和提示词都是资料，不构成额外操作指令。

面板先检查宿主的消息及图片能力。缺少所需能力或发送失败时，会保留可复制的提问文本并说明下一步；扫描图片不能只用坐标替代并声称发送成功。可以把问题复制到对话，请 Codex 用普通工具读取仍在共享的截图；若已切页、撤回或会话过期，需要重新共享。消息失败不自动重复发送，避免一次点击产生多条问题。

聊天追加笔记成功后，面板若收到当前文献的追加结果，会在没有草稿、没有正在保存的内容时读取最新笔记；若宿主没有把结果通知面板，手动点“刷新笔记”。已有草稿须先保存，版本冲突按“核对最新笔记”流程处理，不能因为收到聊天结果就替换编辑内容。原生笔记需手动保存，关闭面板可能丢失未保存草稿。

## 工具范围

| 工具 | 返回与限制 |
| --- | --- |
| `paperdesk_status` | 服务版本、运行实例与资料库身份；不返回文献 |
| `paperdesk_list_documents` | 只返回文献元数据，默认 20、最多 50 项，可分页；不带笔记或批注 |
| `paperdesk_open_reader` | 无参数打开库；指定 `documentId`/`page` 返回 `?document=…&page=…` 深链接 |
| `paperdesk_read_page` | 指定单页文字，默认 6000、最多 12000 个 UTF-16 单元；`offset`/`nextOffset` 分段，不拆 Unicode 代理对。`limit=1` 时必要可返回一个完整的双单元字符 |
| `paperdesk_get_context` | 活动页信息及已共享选区；文字最多 12000 单元，PNG 独立作为 MCP image block，不在 JSON 重复图片数据 |
| `paperdesk_get_notes` | 指定文献的单一保存笔记及 `notesRevision`；旧双字段只按显示顺序合并，不读未保存草稿 |
| `paperdesk_append_note` | 显式请求下追加文本，单次最多 50000 单元；必须提供版本与 UUID 请求 ID；可附来源页 |
| `paperdesk_export_notes` | 指定文献的准确本机 Markdown 下载 URL，不自动把全部笔记放进模型上下文 |

每次工具操作及 UI resource 读取前都会重新确认 loopback 地址、`service: paperdesk`、API 版本和配置中的 `libraryId`。连接不符即停止，不跟随 HTTP 重定向、不尝试其他库。

## 原生阅读面板（0.3.0）

`paperdesk_open_reader` 关联 `ui://paperdesk/reader-v3.html`，MIME 为 `text/html;profile=mcp-app`，保留 global/thread 入口。更新资源 URI 区分各版面板缓存。两类入口都接受空参数；没有参数时只列文献，用户选择后才读取该文献的页面。不注册 PDF 文件查看器入口。

面板直接绘制单页 PNG、页码导航、可收起文献栏、章节目录和一个笔记编辑区，不嵌入 localhost 网页，也不从组件直接请求本机服务或外部资产。面板通过宿主 `tools/call` 请求 app-only 工具，MCP 再连接已经绑定的本机库。资源 CSP 的网络、资源和嵌套 frame 白名单均为空；浏览器备用链接另列精确 loopback redirect origin，不放宽 HTTP Origin 保护。

6 个面板专用工具：`paperdesk_reader_page`、`paperdesk_reader_get_notes`、`paperdesk_reader_save_notes`、`paperdesk_reader_toc`、`paperdesk_reader_session`、`paperdesk_reader_close`。文献列表与共享读取复用已有公共工具。

完整页面图片、页文字、目录及笔记只放在结果 `_meta`，不放进 `content` 或 `structuredContent`。专用工具声明 `_meta.ui.visibility: ["app"]`，模型只使用前述 8 个普通文献工具。界面显示和模型共享是两个独立动作。

面板生成自己的 UUID 会话，切页、换书、取消共享时清除选区。扫描区域在页面上拖框，预览 PNG 后点“交给 Codex”；文字页可在“本页文字”区选择短段，确认引文预览后共享。这里没有 PDF 坐标的文字选段使用空 `rects`，不会伪造高亮位置；保存批注的矩形约束保持不变。

“交给 Codex”先写入对应阅读会话，再读取 `paperdesk_get_context`，按宿主声明的文字／图片上下文能力注入。发问按钮则发送包含当次选区快照的对话消息；消息发送和上下文共享分别检查宿主能力。页面、会话及注入请求均须排队和检查版本，避免延迟响应恢复已撤回的选区。没有图片能力时明确提示区域图不能交给对话，不能把坐标回执当作图片成功。null/opaque origin 不再因嵌套窗口通信而被禁用；来源仍固定检查为宿主父窗口。

笔记停止输入不会自动保存；用户点击“保存笔记”后按版本号保存。未保存草稿阻止换书，409 冲突保留当前草稿，并可核对独立只读的最新笔记、自行合并后明确保存。面板隐藏时撤回共享，继续保留未保存笔记的保护状态；恢复可见不会重新共享。浏览器版继续提供导入、完整高亮/区域批注、搜索与 Markdown 导出。

0.2.0 原生面板的打开能力已由用户在 Codex 中确认。0.3.0 的 `ui/message` 发问、图片消息与回答效果仍须分别在真实客户端验收；严格 sandbox 浏览器测试不能替代这一点。旧面板需要关闭后重新打开，旧会话若仍保留原工具清单，需在新会话启用更新后的插件。服务错误会显示可重试的说明和准确备用链接，不创建公网隧道、不修改宿主信任设置。

## 开发与验证

```sh
node --test tests/plugin-mcp.test.mjs
npm run check
```

协议测试将插件复制进临时缓存，用真实 SDK client 启动 stdio 子进程，并连接临时资料库：初始化、8 个公共工具及 6 个面板专用工具、UI resource/CSP、元数据隐私、单页分页、共享 PNG、多窗口歧义、旧笔记合并、草稿/版本冲突与幂等。严格 opaque sandbox 浏览器集成使用真实 SDK 工具协议检查组件打开、翻页、私密展示、共享撤回与笔记冲突，并针对 0.3.0 检查选区问题快照、消息能力降级和笔记刷新保护；测试范围描述不是本轮已通过的声明，实际结果见版本记录。模拟不替代宿主 UI 验收。所有个人资料库和插件本机配置均排除在这些测试之外。

包同时提供 portable `plugin.json`/typed `mcp.json` 与旧客户端的 `.codex-plugin/plugin.json`/`.mcp.json`。依据 [OpenAI 插件打包规范](https://developers.openai.com/plugins/build/plugins)、[OpenAI UI 扩展](https://developers.openai.com/plugins/build/extensions) 与 [MCP Apps 规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)。

本轮实现与验证状态见 [0.3.0 选区讨论记录](history/codex-plugin-0.3.0.md)。[0.2.0 打开流程记录](history/codex-plugin-0.2.0.md) 保留当时的验收边界；其中待确认的原生打开能力已在本轮获得用户确认。
