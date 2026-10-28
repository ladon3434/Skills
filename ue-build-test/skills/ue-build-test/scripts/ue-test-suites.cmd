@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-test-suites.mjs" %*
exit /b %errorlevel%
