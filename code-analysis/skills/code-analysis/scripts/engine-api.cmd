@echo off
chcp 65001 >nul
node "%~dp0mjs\engine-api.mjs" %*
exit /b %errorlevel%
