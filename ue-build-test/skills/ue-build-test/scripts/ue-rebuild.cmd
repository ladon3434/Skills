@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-rebuild.mjs" %*
exit /b %errorlevel%
