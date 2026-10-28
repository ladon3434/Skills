@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-wait-editor.mjs" %*
exit /b %errorlevel%
