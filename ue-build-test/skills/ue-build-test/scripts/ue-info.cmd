@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-tools.mjs" %*
exit /b %errorlevel%
