@echo off
chcp 65001 >nul
node "%~dp0mjs\generate-clang-database.mjs" %*
exit /b %errorlevel%
