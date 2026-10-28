@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-run-editor-headless.mjs" %*
exit /b %errorlevel%
