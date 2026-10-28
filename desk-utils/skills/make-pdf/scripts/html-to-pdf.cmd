@echo off
REM HTML -> PDF (or PNG preview) with headless Chrome or Edge, found on this machine.
chcp 65001 >nul
node "%~dp0mjs\html-to-pdf.mjs" %*
exit /b %errorlevel%
