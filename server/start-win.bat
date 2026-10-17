@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules ( call npm install )
echo.
echo 正在启动简易笔记云同步服务...
node server.js
pause
