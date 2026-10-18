@echo off
REM Thin shim: the logic lives in mjs\discarded-verdict-lint.mjs.
REM Usage: discarded-verdict-lint.cmd ^<file...^> ^| --all [--root dir]... [--with dir]... [--marker WORD] ^| --selftest
chcp 65001 >nul
node "%~dp0mjs\discarded-verdict-lint.mjs" %*
exit /b %errorlevel%
