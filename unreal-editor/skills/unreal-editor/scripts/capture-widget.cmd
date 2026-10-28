@echo off
chcp 65001 >nul
node "%~dp0mjs\capture-widget.mjs" %*
exit /b %errorlevel%
