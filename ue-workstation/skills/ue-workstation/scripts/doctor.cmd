@echo off
chcp 65001 >nul
node "%~dp0mjs\doctor.mjs" %*
exit /b %errorlevel%
