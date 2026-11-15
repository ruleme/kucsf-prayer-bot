@echo off
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0start-test-bot.ps1" -StartTunnel
pause
