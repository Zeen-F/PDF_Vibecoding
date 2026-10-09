# 知识工作台交换接口

在 Obsidian 仓库模式选中文字或区域后，点击“发送到知识库”，核对实际 PDF 页并补充想法。只导出本次选区；不发送模型请求，不修改原 PDF 或批注。工作台关闭时也能积累材料。

`POST /api/integrations/knowledge/export` 接收 `requestId`（UUID）、`documentId`、`page`（实际页，1 起）、归一化 `rects`、`quote`、`comment` 和可选 PNG `image`（base64 或 data URL，最多 20 MiB）。同一 requestId 与相同内容重试返回同一个包；改变内容必须使用新 requestId。

包位于 `<Paperdesk 子目录>/Exports/<requestId>/`：先持久化 `selection.png`，再写 `manifest.json`。清单 schema 为 `paperdesk-capture/v1`，包含 source 的文献 UUID、标题、PDF SHA-256、仓库相对路径、笔记路径、实际页、选区和引文，以及 comment 和图片 SHA-256。`.request.json` 保留未完成请求身份。消费者等待清单及附件完整且校验通过，按 id 去重，不能移除原包。

工作台与纸间连接同一个 Obsidian 库。阅读笔记正文仍走纸间现有带 `expectedNotesRevision` 的 PATCH 接口，生成批注和隐藏状态继续由纸间维护。工作台独立记录导入材料和审核结果。

此功能不增加自动 OCR、库同步或后台 AI 整理。
