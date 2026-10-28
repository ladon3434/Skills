@echo off
chcp 65001 >nul
node "%~dp0mjs\dump-toolset-schemas.mjs" %*
exit /b %errorlevel%
