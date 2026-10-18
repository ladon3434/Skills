@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-clean.mjs" %*
exit /b %errorlevel%
