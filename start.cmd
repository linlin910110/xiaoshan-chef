@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，无法启动本地服务。
  echo 请安装 Node.js 18+（https://nodejs.org），或者直接在浏览器打开 http://127.0.0.1:8137/
  pause
  exit /b 1
)
node serve.mjs 8137
pause
