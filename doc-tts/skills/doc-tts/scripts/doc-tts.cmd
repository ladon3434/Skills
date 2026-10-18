@echo off
REM Markdown -> MP3 with a local neural voice (ComfyUI stand + Qwen3-TTS), or edge-tts with --engine edge.
chcp 65001 >nul
setlocal
set "PY="
if defined PYTHON set "PY=%PYTHON%"
if not defined PY for %%P in (python.exe) do set "PY=%%~$PATH:P"
if not defined PY for /f "delims=" %%P in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%P"
if not defined PY echo doc-tts: no Python 3 found - put python on PATH or set PYTHON>&2& exit /b 2
"%PY%" -B "%~dp0doc_tts.py" %*
exit /b %errorlevel%
