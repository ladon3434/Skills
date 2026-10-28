@echo off
chcp 65001 >nul
node "%~dp0mjs\capture-level.mjs" %*
exit /b %errorlevel%
