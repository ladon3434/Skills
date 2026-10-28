@echo off
REM Refuses hardcoded /Game/ asset paths and project ConstructorHelpers finders in shipped C++ modules.
chcp 65001 >nul
node "%~dp0mjs\asset-path-lint.mjs" %*
exit /b %errorlevel%
