@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-proc.mjs" %*
exit /b %errorlevel%
