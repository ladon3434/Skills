@echo off
chcp 65001 >nul
node "%~dp0mjs\log-scan.mjs" %*
exit /b %errorlevel%
