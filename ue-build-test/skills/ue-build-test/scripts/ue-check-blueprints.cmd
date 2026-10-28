@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-check-blueprints.mjs" %*
exit /b %errorlevel%
