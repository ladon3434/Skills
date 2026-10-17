@echo off
chcp 65001 >nul
node "%~dp0mjs\install-agent-tools.mjs" %*
exit /b %errorlevel%
