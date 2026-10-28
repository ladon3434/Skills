@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-validate-data.mjs" %*
exit /b %errorlevel%
