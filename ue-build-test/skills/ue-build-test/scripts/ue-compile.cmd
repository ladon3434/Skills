@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-compile.mjs" %*
exit /b %errorlevel%
