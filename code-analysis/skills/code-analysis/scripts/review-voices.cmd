@echo off
chcp 65001 >nul
node "%~dp0mjs\review-voices.mjs" %*
exit /b %errorlevel%
