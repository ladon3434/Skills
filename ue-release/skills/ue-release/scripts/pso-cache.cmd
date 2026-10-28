@echo off
chcp 65001 >nul
node "%~dp0mjs\pso-cache.mjs" %*
exit /b %errorlevel%
