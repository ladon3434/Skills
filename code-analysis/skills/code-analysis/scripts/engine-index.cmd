@echo off
chcp 65001 >nul
node "%~dp0mjs\engine-index.mjs" %*
exit /b %errorlevel%
