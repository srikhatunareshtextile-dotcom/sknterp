@echo off
title Add Mobile App Server to Startup
cd /d "%~dp0"
echo Adding Mobile Server to Windows Startup...
powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut(\"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\MobileServer.lnk\"); $Shortcut.TargetPath = 'wscript.exe'; $Shortcut.Arguments = '\"%cd%\Start_Mobile_Server_Silent.vbs\"'; $Shortcut.WorkingDirectory = '%cd%'; $Shortcut.Save()"
echo Successfully added to Windows Startup!
echo The Mobile Server will now automatically start in the background when this computer starts.
pause
