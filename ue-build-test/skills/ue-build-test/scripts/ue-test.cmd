@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-test.mjs" %*
exit /b %errorlevel%
