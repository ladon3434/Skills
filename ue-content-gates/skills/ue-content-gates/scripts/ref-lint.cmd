@echo off
REM Forbidden-reference gate: no package references a package under a forbidden prefix.
REM Offline: Python 3 (stdlib only), no editor.
chcp 65001 >nul
setlocal
set "PY="
if defined PYTHON set "PY=%PYTHON%"
if not defined PY for %%P in (python.exe) do set "PY=%%~$PATH:P"
if not defined PY for /f "delims=" %%P in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%P"
if not defined PY echo ref-lint: no Python 3 found - put python on PATH or set PYTHON>&2& exit /b 2
"%PY%" -B "%~dp0py\ref_lint.py" %*
exit /b %errorlevel%
