#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  BUNDLED_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
  if [[ -x "$BUNDLED_NODE/node" ]]; then export PATH="$BUNDLED_NODE:$PATH"; fi
fi
if ! command -v node >/dev/null 2>&1; then
  print '未找到 Node.js。请安装 Node.js 24 LTS，再重新打开。'
  read '?按回车关闭…'; exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  print 'Node.js 版本过旧。请安装 Node.js 24 LTS，再重新打开。'
  read '?按回车关闭…'; exit 1
fi
if [[ ! -d node_modules ]]; then
  print '正在准备首次运行所需的依赖（此步骤需要网络）…'
  npm ci || { read '?安装失败，按回车关闭…'; exit 1; }
fi
if [[ ! -f dist/index.html ]]; then
  npm run build || { read '?准备界面失败，按回车关闭…'; exit 1; }
fi
node scripts/launch.mjs
