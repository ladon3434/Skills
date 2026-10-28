@echo off
chcp 65001 >nul
node "%~dp0mjs\merge-settings.mjs" %*
exit /b %errorlevel%
