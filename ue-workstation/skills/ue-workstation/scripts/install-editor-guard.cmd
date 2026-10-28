@echo off
chcp 65001 >nul
node "%~dp0mjs\install-editor-guard.mjs" %*
exit /b %errorlevel%
