@echo off
title Stop Sri Khatu Naresh Mobile App Server
cd /d "%~dp0"
echo Finding and stopping the mobile server on port 5000...
set "found="
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5000" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a
    set "found=1"
    echo Mobile Server (PID %%a) has been stopped.
)
if not defined found (
    echo Mobile Server is not currently running.
)
echo Done!
pause
