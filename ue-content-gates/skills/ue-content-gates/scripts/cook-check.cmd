@echo off
REM Expected-vs-cooked diff: does the last cook carry the dependency closure of the reference set.
chcp 65001 >nul
node "%~dp0mjs\cook-check.mjs" %*
exit /b %errorlevel%
