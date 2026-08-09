@echo off
title Open Port 5000 in Windows Firewall
echo Requesting administrator privileges...
net session >nul 2>&1
if %errorLevel% == 0 (
    echo Opening TCP port 5000 in Windows Firewall...
    netsh advfirewall firewall add rule name="Sri Khatu Naresh Mobile App Port 5000" dir=in action=allow protocol=TCP localport=5000
    echo Port 5000 opened successfully!
    pause
) else (
    echo.
    echo ERROR: Please right-click this file and choose "Run as Administrator"!
    echo.
    pause
)
