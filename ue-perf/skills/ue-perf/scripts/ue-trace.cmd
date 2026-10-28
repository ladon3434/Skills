@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-trace.mjs" %*
exit /b %errorlevel%
