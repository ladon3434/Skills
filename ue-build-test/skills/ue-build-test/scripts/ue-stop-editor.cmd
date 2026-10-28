@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-stop-editor.mjs" %*
exit /b %errorlevel%
