@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-tail-log.mjs" %*
exit /b %errorlevel%
