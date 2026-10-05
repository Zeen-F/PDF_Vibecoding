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

- “打开纸间”返回准确本机链接。支持 MCP Apps 的宿主还可尝试原生阅读面板。
- 在阅读器选中文字或框选区域，然后点击“交给 Codex”。文字、区域坐标和区域 PNG 只在主动共享后进入短期阅读会话；切页、换书或取消共享会撤回当前选区。
- “解释共享的选区”读取指定会话。多个普通阅读窗口同时活动时，工具返回窗口列表，调用者必须选定 `sessionId`，不能猜第一个窗口。
- AI 回答只在用户明确要求“记下来”“追加到笔记”等时追加。笔记仍是单一编辑区，不强制按语言分开。
- 未保存草稿或笔记版本冲突时返回 409；先在阅读器处理草稿或核对最新笔记，不能强制覆盖。相同追加重试保留原文本、原版本和同一 UUID `requestId`，不能换版本盲重试。

选区会话保存在服务内存中，30 秒无心跳过期，重启后消失。追加请求的幂等记录保留 10 分钟，服务重启后清空；旧版本号仍阻止已成功追加的旧请求再次写入。可用消息桥的面板会在撤回共享时清除当前注入上下文，但不能收回普通工具返回、历史对话或已生成回答中的内容。

扫描区域截图不是 OCR，也不会把图片中的文字加入搜索索引。插件没有录屏、任意文件读取、SQL、删除或自动整书提取工具。文献、笔记和图片中的提示词只能作为资料处理。

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

## 原生 UI：实验性

`paperdesk_open_reader` 关联 `ui://paperdesk/reader.html`，MIME 为 `text/html;profile=mcp-app`，同时声明 OpenAI 的 global/thread 入口。两类入口都接受空参数；尚未注册 PDF 文件查看器入口，因为宿主文件资源还没有安全导入和映射流程。

wrapper 内嵌已有本机阅读器，CSP 只列出配置的精确 loopback origin。它生成独立 `readerSession` 并固定读取此会话，避免和外部浏览器窗口混淆。iframe 通知只接受既定子窗口及 origin；阅读器也核对 parentOrigin 与 referrer。opaque/null origin 无法可靠接收撤回通知，因此同时禁用子窗口消息桥、面板读取按钮与 `ui/update-model-context`。这种环境只通过对话里的普通 MCP 工具按需读取主动共享内容，不使用通配来源传送选区。

共享时先通过 `tools/call` 从后端读取会话，再按宿主 `hostCapabilities.updateModelContext` 声明的 text/image/structuredContent 能力调用 `ui/update-model-context`。心跳不会反复调用工具。上下文写入串行化，取消共享排在进行中的注入之后清空，避免延迟响应恢复旧选区。

自动化测试验证了资源内容、来源校验、能力协商与延迟取消协议，**不代表当前 Codex/ChatGPT 桌面客户端已实际渲染原生面板或接收模型上下文**。宿主版本、CSP、内嵌本机网络访问和支持的扩展都可能影响显示。若面板不可用，使用返回的本机链接与普通工具；不放宽 API Origin、不创建公网隧道，也不自动更改宿主信任设置。

## 开发与验证

```sh
node --test tests/plugin-mcp.test.mjs
npm run check
```

协议测试将插件复制进临时缓存，用真实 SDK client 启动 stdio 子进程，并连接临时资料库：初始化、8 个工具、UI resource/CSP、元数据隐私、单页分页、共享 PNG、多窗口歧义、旧笔记合并、草稿/版本冲突与幂等。另用消息模拟检查 wrapper 的来源过滤、能力降级、心跳去重、延迟取消与 opaque origin 禁用注入；模拟不替代宿主 UI 验收。所有个人资料库和插件本机配置均排除在这些测试之外。

包同时提供 portable `plugin.json`/typed `mcp.json` 与旧客户端的 `.codex-plugin/plugin.json`/`.mcp.json`。依据 [OpenAI 插件打包规范](https://developers.openai.com/plugins/build/plugins)、[OpenAI UI 扩展](https://developers.openai.com/plugins/build/extensions) 与 [MCP Apps 规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)。
