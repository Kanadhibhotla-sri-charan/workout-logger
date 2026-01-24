@echo off
set PYTHONPATH=.
call venv\Scripts\activate
echo Starting Web Server at http://127.0.0.1:5000
python src\web\app.py
pause
