# 仓库与本机工作区

仓库只保存可共享的源码、示例、测试与文档。本机文献库、构建结果和验收材料放在忽略目录，不提交 Git。

## 源码与文档

最新版发布源码按下列用途安排：

```text
README.md                  项目介绍、功能和下载入口
LICENSE                    MIT 许可证
AGENTS.md                  开发助手约定
CONTRIBUTING.md             贡献与检查流程
package.json / lock        运行命令与锁定依赖
src/                       界面、PDF 阅读与笔记交互
server/                    本机 API、PDF 处理和 SQLite 存储
shared/                    浏览器与服务共享的契约
desktop/                  macOS 桌面窗口与服务管理
plugins/paperdesk/          可选 Codex 插件
public/examples/           原创阅读示例
scripts/                   启动、构建、测试与打包入口
tests/                     自动检查和可共享测试材料
docs/
  API.md                   API 契约
  architecture.md          架构与数据流
  development.md           开发说明
  desktop-release.md       桌面安装与发布
  browser-release.md       本机浏览器 ZIP 说明
  history/                 历史变更及原始验收记录
.github/workflows/         GitHub 自动检查与发布流程
```

默认分支暂时保留早期源码，最新功能源码对应 `v1.1.0-beta.4` 发布标签，后续功能仍通过独立 PR 整合；本说明不改变历史标签。早期分支不包含全部桌面或插件目录。每个分支的 API 文档描述该分支自己的实现，不能用最新契约替代旧实现。

根目录保留运行配置、编辑器配置和 Mac 启动器，便于直接打开和启动项目。详细说明集中到 `docs/`，历史原始验收记录保存在 `docs/history/original-acceptance.md`，不放在首页根目录。

## 本机生成内容

```text
data/                                  正式文献库，保留当前位置
.local/
  dev-data/                            开发模式按需生成的隔离库
  desktop-assets/                      桌面图标构建资源，脚本固定使用
  verification/
    desktop/                           桌面测试的最新截图
    release-1.1.0-beta.4/               本次发布的日志、截图及安装验收副本
  publication/2026-10-08/               本次发布与开源检查的本机记录
  archives/release-candidates/          早期安装包候选及临时构建副本
  organization/                        本机整理的移动清单与校验记录
node_modules/                          可按锁文件重新安装的依赖
dist/                                  可重新构建的浏览器界面
release/                               当前版本的安装包、浏览器 ZIP 和校验文件
```

这些路径均不提交 Git。正式 PDF、数据库、笔记、已有备份及迁移记录不参与构建材料归档。桌面版独立文献库位于应用之外，不因整理项目目录而移动。

本次只归档本轮生成的发布与验证文件；不认识的本机文件保留原位。移动清单在 `.local/organization/` 中记录旧位置、新位置和校验信息，便于找回。大目录移动时保留原有字节；不去重、不删除安装副本，也不清理文献资料。

## 后续开发

- 功能或修复在独立分支完成，通过检查后合并到 `main`。
- 发布包继续输出到 `release/`，验收使用隔离目录和原创示例。
- 新文档放在 `docs/`，历史证据放在 `docs/history/`；本机含路径或私人内容的检查记录留在 `.local/`。
- 不手工移动 `data/`、`node_modules/`、`dist/` 或脚本固定依赖的目录来整理外观。
