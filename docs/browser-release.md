# 本机浏览器发布包

本版为 **1.2.0-beta.1** 预览版，在 [对应 Release](https://github.com/Zeen-F/PDF_Vibecoding/releases/tag/v1.2.0-beta.1) 下载 `Paperdesk-1.2.0-beta.1-browser.zip`。它与同版本桌面版使用相同的阅读代码，已包含构建好的界面。下载后安装 Node.js 24+，解压 ZIP，在解压目录执行：

```sh
npm ci --omit=dev
npm start
```

打开 `http://127.0.0.1:4317`；使用期间保留终端，结束时按 Control+C。安装依赖需要联网，未启用翻译或 Codex 时，普通阅读、批注、笔记与检索在本机处理。浏览器包的发布验收范围为 macOS；其他系统尚未验证。

默认文献库位于解压目录的 `data/`，也可通过 `PAPERDESK_DATA_DIR` 指定固定位置。更新前正常停止服务并备份完整文献库，不覆盖或删除已有资料。服务只监听本机 `127.0.0.1`。

本版增加 Obsidian 仓库和个人页面书签，数据库使用 schema 5。服务在修改旧数据库结构前创建并读回检查一致性备份，包含已提交 WAL 内容，备份失败会停止升级。自动快照不能替代 PDF 和笔记的完整备份。第一次启动新版前正常停止旧服务并备份完整资料；回退旧版先停止新版，再恢复升级前完整备份。新选择 schema 3 或更早独立库时，可先用此包完成升级，再从桌面菜单选择；具体步骤见 [升级到 1.2.0-beta.1](desktop-release.md#升级到-120-beta1)。

## 使用 Obsidian 仓库

安装生产依赖后，可在同一解压目录通过环境变量启动：

```sh
PAPERDESK_VAULT_DIR="/absolute/path/to/YourVault" \
PAPERDESK_VAULT_SUBDIR="Paperdesk" \
npm start
```

选择已经存在且包含 `.obsidian/` 的知识库根目录；`PAPERDESK_VAULT_SUBDIR` 可省略，默认 `Paperdesk`。侧边栏显示已有 PDF，点击原位阅读；也可导入外部 PDF，副本保存在 `Paperdesk/PDFs/`，外部原文件保留。笔记、批注和实际 PDF 页书签保存在 `Paperdesk/Notes/`，正文可在两边编辑。

此模式的 `PAPERDESK_DATA_DIR` 用于库外索引、翻译设置与恢复资料，省略时使用按库身份独立的系统用户数据目录。它必须位于整个知识库之外；不能把解压目录的 `data/` 误当正式 Markdown 所在位置。旧 v1／v2 管理 Markdown 可读，成功保存时写入 v3，保留原位或导入来源。备份时保存整个知识库及库外数据目录更方便；冲突、源文件位置和手动合并规则见 [仓库说明](obsidian-vault.md)。

## 构建与验收

源码工作区先运行 `npm ci`，然后执行 `npm run browser:dist`。输出位于忽略的 `release/`：

- `Paperdesk-<版本>-browser.zip`
- `SHA256SUMS-browser`

打包器只选取明确允许的 Git 跟踪文件、MIT 许可证和构建后的 `dist/`；包内不含 `node_modules/`、正式文献库、`.local/`、数据库、日志或环境变量文件。生产依赖按锁文件在使用者本机安装。包内保留源代码和 `START-HERE.md`，可在安装开发依赖后重新构建。

发布前需在独立目录解压，安装生产依赖，并实际启动包内服务；使用原创示例检查 PDF 渲染、引文批注、笔记保存、书签、导出、停止和重启后的读回，并检查合成 Obsidian 知识库的原位文件与外部导入。测试资料不能使用正式文献库。完成读回与证据核对后，停止测试进程，保留验收摘要和校验值，清理合成文献库、解压安装副本及依赖缓存。浏览器包、桌面包和匿名下载校验分别记录，以 [本版说明](history/1.2.0-beta.1.md) 与实际结果为准。

浏览器 ZIP 使用单独的校验文件，不改写已发布桌面安装包的校验值。Release 中附带的 MIT 许可证适用于本项目代码；第三方依赖保留自己的许可证。已有版本标签和已发布的桌面二进制不覆盖。
