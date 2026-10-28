@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-launch-editor.mjs" %*
exit /b %errorlevel%
