@echo off
chcp 65001 >nul
node "%~dp0mjs\clean-clangd.mjs" %*
exit /b %errorlevel%
