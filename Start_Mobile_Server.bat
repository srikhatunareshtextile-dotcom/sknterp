@echo off
title Sri Khatu Naresh Mobile App Server
cd /d "%~dp0"

echo Checking python dependencies...
python -c "import flask" 2>nul
if %errorlevel% neq 0 (
    echo Flask is not installed. Installing Flask...
    python -m pip install flask
    if %errorlevel% neq 0 (
        echo Failed to install Flask. Please check your internet connection.
        pause
        exit /b %errorlevel%
    )
)

python -c "import pyodbc" 2>nul
if %errorlevel% neq 0 (
    echo pyodbc is not installed. Installing pyodbc...
    python -m pip install pyodbc
    if %errorlevel% neq 0 (
        echo Failed to install pyodbc. Please check your internet connection.
        pause
        exit /b %errorlevel%
    )
)

echo Starting Ngrok Static Tunnel in background...
start "" /B ngrok.exe http --request-header-add "ngrok-skip-browser-warning: true" --url=pesky-fable-lividly.ngrok-free.dev 5000 > ngrok_tunnel.log 2>&1

echo Starting Background Cloud Data Sync Service...
start "" /B python run_cloud_sync.py > cloud_sync.log 2>&1

echo Starting Sri Khatu Naresh Mobile App Server...
python app.py
pause

