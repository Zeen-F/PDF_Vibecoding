# 知识工作台交换接口

在 Obsidian 仓库模式选中文字或区域后，点击“发送到知识库”，核对实际 PDF 页并补充想法。只导出本次选区；不发送模型请求，不修改原 PDF 或批注。工作台关闭时也能积累材料。

入口位于桌面版和本机浏览器版的选区操作栏。Codex 原生纸间阅读面板目前仍使用其已有的共享／提问入口；本轮不增加原生面板按钮。本机 `1.2.0-beta.3` Windows ZIP 已包含此功能并完成打包联调，详见[本机交付记录](history/1.2.0-beta.3.md)。GitHub 已发布的 `v1.2.0-beta.2` 包不包含它。

`POST /api/integrations/knowledge/export` 接收 `requestId`（UUID）、`documentId`、`page`（实际页，1 起）、归一化 `rects`、`quote`、`comment` 和可选 PNG `image`（base64 或 data URL，最多 20 MiB）。同一 requestId 与相同内容重试返回同一个包；改变内容必须使用新 requestId。

包位于 `<Paperdesk 子目录>/Exports/<requestId>/`：先持久化 `selection.png`，再写 `manifest.json`。清单 schema 为 `paperdesk-capture/v1`，包含 source 的文献 UUID、标题、PDF SHA-256、仓库相对路径、笔记路径、实际页、选区和引文，以及 comment 和图片 SHA-256。`.request.json` 保留未完成请求身份。消费者等待清单及附件完整且校验通过，按 id 去重，不能移除原包。

工作台与纸间连接同一个 Obsidian 库。阅读笔记正文仍走纸间现有带 `expectedNotesRevision` 的 PATCH 接口，生成批注和隐藏状态继续由纸间维护。工作台独立记录导入材料和审核结果。

`GET /api/integrations/knowledge/status` 返回 `schema: paperdesk-knowledge/v1`、本机 `vaultPath` 和 `subdir`，供工作台核对真实库路径；仅凭同名库或相同端口不能确认身份。连同 `/api/plugin/status` 的 `libraryId` 保存绑定。

`GET /api/integrations/knowledge/source/:id` 读回原 PDF 并核对哈希，返回 `documentId`、`pdfSha256`、`pageCount`、`pdfPath`、`notePath`。工作台核对采集时哈希和实际页码后，使用 `/?document=<UUID>&page=<实际页>` 打开阅读器。源文件缺失、改变或服务离线时，保留已保存的选区和想法，不自动跳到其他文献。

发送失败时窗口保留原输入，重试使用同一个请求标识。未完成发送会阻止切换页码及正常退出；明确点击“放弃本次发送”才丢弃当前输入。尚未提交的发送内容只保留在当前窗口，不承诺异常退出后的恢复。交换包已经落盘但回执丢失时，重试读回清单与附件后确认，损坏的包不会被当作成功保存。

验证：纸间的 `npm run check` 包含导出幂等、输入冲突、原图损坏及 PDF 身份校验；知识工作台的 `test:paperdesk` 在两个真实服务和浏览器界面间验证文字／区域选区、失败重试、离线导入、缺失附件等待、图片复用及来源跳页。使用原创合成 PDF 和临时库，不访问个人文献。

此功能不增加自动 OCR、库同步或后台 AI 整理。
