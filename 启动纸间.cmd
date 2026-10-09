@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0" || exit /b 1
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请安装 Node.js 24 LTS 后重新打开。
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 版本过旧，请安装 Node.js 24 LTS 后重新打开。
  pause
  exit /b 1
)
if not exist "node_modules\express\package.json" (
  echo 正在安装锁定的依赖，此步骤需要网络……
  call npm.cmd ci
  if errorlevel 1 goto failed
)
if not exist "dist\index.html" (
  call npm.cmd run build
  if errorlevel 1 goto failed
)
node scripts/launch.mjs
if errorlevel 1 goto failed
exit /b 0
:failed
echo 启动未完成，请查看上方错误。
pause
exit /b 1
