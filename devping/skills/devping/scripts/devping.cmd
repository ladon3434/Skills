@echo off
chcp 65001 >nul 2>&1
setlocal
set "PY="
if defined PYTHON set "PY=%PYTHON%"
if not defined PY for %%P in (python.exe) do set "PY=%%~$PATH:P"
REM The Microsoft Store alias is a python.exe on PATH that only prints an advert: a candidate must run.
if defined PY "%PY%" -c "import sys" >nul 2>&1 || set "PY="
if not defined PY for /f "delims=" %%P in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%P"
if not defined PY echo devping: no Python 3 found - put python on PATH or set PYTHON>&2& exit /b 2
"%PY%" "%~dp0devping.py" %*
exit /b %errorlevel%
