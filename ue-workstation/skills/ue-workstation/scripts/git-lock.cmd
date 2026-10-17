@echo off
chcp 65001 >nul
node "%~dp0mjs\git-lock.mjs" %*
exit /b %errorlevel%
