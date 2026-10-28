@echo off
chcp 65001 >nul
node "%~dp0..\tests\hooks-test.mjs" %*
exit /b %errorlevel%
