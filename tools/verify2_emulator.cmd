@echo off
REM verify2 emulator launcher (ASCII only: cmd.exe mis-decodes non-ASCII .cmd files).
REM Why this exists:
REM  - adb server and emulator must start inside one process tree that pwsh's error
REM    handling cannot tear down (a piped emulator run made pwsh exit and killed it).
REM  - emulator home/adbkey cannot be written under C:\Users\...\.android, so the
REM    whole tree uses ANDROID_USER_HOME inside the workspace.
REM  - this script must run as a background job; the trailing timeout keeps the
REM    emulator alive after the job would otherwise end.
setlocal
cd /d "%~dp0.."
set "WS=%CD%"
set "AHROOT=%WS%\verify2-out\android-home"
set "ANDROID_USER_HOME=%AHROOT%"
set "ANDROID_SDK_HOME=%AHROOT%"
set "ANDROID_PREFS_ROOT=%AHROOT%"
set "ANDROID_EMULATOR_HOME=%AHROOT%"
set "ANDROID_AVD_HOME=D:\android-avd-home"
set "ANDROID_SDK_ROOT=D:\android-sdk"
set "ANDROID_HOME=D:\android-sdk"

echo [verify2] workspace=%WS%
echo [verify2] avd home=%ANDROID_AVD_HOME%

"D:\android-sdk\platform-tools\adb.exe" start-server
"D:\android-sdk\emulator\emulator.exe" -avd jizhang_test -no-boot-anim -gpu swiftshader_indirect -no-snapshot -no-window -no-metrics 1>"%WS%\verify2-out\emulator-run.log" 2>&1
echo [verify2] emulator exited with %ERRORLEVEL%>>"%WS%\verify2-out\emulator-run.log"
timeout /t 86400 /nobreak >nul
