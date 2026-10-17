@echo off
REM Which .uasset/.umap files use a C++ symbol (class, struct, enum, member, module).
REM Offline: Python 3 (stdlib only), no editor.
chcp 65001 >nul
setlocal
set "PY="
if defined PYTHON set "PY=%PYTHON%"
if not defined PY for %%P in (python.exe) do set "PY=%%~$PATH:P"
if not defined PY for /f "delims=" %%P in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%P"
if not defined PY echo find-asset-refs: no Python 3 found - put python on PATH or set PYTHON>&2& exit /b 2
"%PY%" -B "%~dp0py\find_asset_refs.py" %*
exit /b %errorlevel%
