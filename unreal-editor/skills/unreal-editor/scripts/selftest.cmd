@echo off
REM Offline self-tests of the unreal-editor scripts: no editor, no live MCP server, no live process table.
chcp 65001 >nul
set FAILED=0
node "%~dp0mjs\ue-project.mjs" --selftest || set FAILED=1
node "%~dp0mjs\ue-owner.mjs" --selftest || set FAILED=1
node "%~dp0mjs\dump-toolset-schemas.mjs" --selftest || set FAILED=1
node "%~dp0mjs\dump-toolset-schemas.mjs" --check || set FAILED=1
node "%~dp0test\ue-py-test.mjs" || set FAILED=1
node "%~dp0mcp-bridge\test\bridge-test.mjs" || set FAILED=1
if "%FAILED%"=="1" (echo selftest: FAILED) else (echo selftest: all ok)
exit /b %FAILED%
