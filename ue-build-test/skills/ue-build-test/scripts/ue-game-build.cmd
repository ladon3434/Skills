@echo off
chcp 65001 >nul
node "%~dp0mjs\ue-game-build.mjs" %*
exit /b %errorlevel%
