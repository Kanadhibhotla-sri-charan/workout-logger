@echo off
set PYTHONPATH=.
call venv\Scripts\activate
python src\main.py %*

:: Pause so the window doesn't close immediately when double-clicked
pause
