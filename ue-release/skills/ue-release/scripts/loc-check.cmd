@echo off
chcp 65001 >nul
node "%~dp0mjs\loc-check.mjs" %*
exit /b %errorlevel%
