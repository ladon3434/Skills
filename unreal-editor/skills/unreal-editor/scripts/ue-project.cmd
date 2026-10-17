@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-project.mjs" %*
exit /b %errorlevel%
