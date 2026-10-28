@echo off
REM Asset naming and placement convention: prefixes by asset class, characters, folders. Offline, no editor.
chcp 65001 >nul
node "%~dp0mjs\asset-name-lint.mjs" %*
exit /b %errorlevel%
