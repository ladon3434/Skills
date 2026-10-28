@echo off
chcp 65001 >nul
node "%~dp0mjs\release-preflight.mjs" %*
exit /b %errorlevel%
