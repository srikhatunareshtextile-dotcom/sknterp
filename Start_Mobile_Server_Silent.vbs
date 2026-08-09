Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = scriptDir & "\Start_Mobile_Server.bat"
WshShell.Run Chr(34) & scriptPath & Chr(34), 0, False
