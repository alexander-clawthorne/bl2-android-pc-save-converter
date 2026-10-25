@echo off
rem Borderlands 2 save converter: Wicked's Android port (v1.7) <-> PC. Drag one or more save files onto this file.
rem Needs Python 3. Output goes to a "converted to pc" / "converted to mobile" folder in this folder.
if "%~1"=="" (
  echo Drag a Borderlands 2 save file ^(SaveXXXX.sav, profile.bin or Player1^) onto this file.
  pause
  exit /b 1
)
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0bl2_convert.py" %*
) else (
  python "%~dp0bl2_convert.py" %*
)
pause
