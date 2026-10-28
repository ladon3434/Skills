@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-selftest.mjs" %*
exit /b %errorlevel%
