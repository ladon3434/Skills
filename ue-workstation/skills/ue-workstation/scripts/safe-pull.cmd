@echo off
chcp 65001 >nul
node "%~dp0mjs\safe-pull.mjs" %*
exit /b %errorlevel%
