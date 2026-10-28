@echo off
chcp 65001 >nul
node "%~dp0mjs\skill-lint.mjs" %*
exit /b %errorlevel%
