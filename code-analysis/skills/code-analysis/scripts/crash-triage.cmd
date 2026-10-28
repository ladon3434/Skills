@echo off
chcp 65001 >nul
node "%~dp0mjs\crash-triage.mjs" %*
exit /b %errorlevel%
