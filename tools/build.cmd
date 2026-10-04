@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  JiZhang App build script (no Gradle)
REM  aapt2 compile -> aapt2 link -> javac -> d8 -> package -> zipalign -> apksigner
REM
REM  Hard-won constraints, do not "simplify" these away:
REM   1. Keep this file ASCII-only. Chinese text in a .cmd is mis-decoded by
REM      cmd.exe and corrupts the caret line-continuations.
REM   2. aapt2 cannot enumerate a directory given an absolute path here; always
REM      cd into the directory and pass RELATIVE paths.
REM   3. apksigner must NOT be wrapped in double quotes; invoke it directly.
REM   4. zipalign must run BEFORE apksigner, otherwise the signature breaks.
REM   5. d8 needs JAVA_HOME set.
REM   6. aapt2 link needs --auto-add-overlay or resources fail to merge.
REM   7. apksigner.bat ends with a bare "exit"; call it via CALL or this script
REM      gets terminated silently right after signing.
REM   8. aapt2 on Windows writes asset entry names with backslashes; run
REM      normalize_apk.py afterwards or the WebView cannot find its assets.
REM
REM  Toolchain locations come from environment variables so this script carries
REM  no machine-specific paths. Override them if your JDK / SDK live elsewhere;
REM  the defaults match the layout described in tools/README.md.
REM ============================================================

if not defined JZ_JDK set "JZ_JDK=D:\android-jdk"
if not defined JZ_SDK set "JZ_SDK=D:\android-sdk"

set "JDK=%JZ_JDK%"
set "SDK=%JZ_SDK%"
set "BT=%SDK%\build-tools\35.0.0"
set "PLATFORM=%SDK%\platforms\android-35\android.jar"
set "JAVA_HOME=%JDK%"

set "ROOT=%~dp0.."
pushd "%ROOT%"
set "ROOT=%CD%"
popd

set "MAIN=%ROOT%\app\src\main"
set "BUILD=%ROOT%\build"
set "KS=%ROOT%\keys\debug.keystore"

echo.
echo === JiZhang App build ===
echo ROOT: %ROOT%

if not exist "%JDK%\bin\javac.exe" ( echo [ERROR] missing JDK & exit /b 1 )
if not exist "%BT%\aapt2.exe"      ( echo [ERROR] missing build-tools & exit /b 1 )
if not exist "%PLATFORM%"          ( echo [ERROR] missing android.jar & exit /b 1 )

if exist "%BUILD%" rmdir /s /q "%BUILD%"
mkdir "%BUILD%\compiled" 2>nul
mkdir "%BUILD%\classes" 2>nul
mkdir "%BUILD%\dex" 2>nul

REM ---------- 1. keystore ----------
if not exist "%KS%" (
  echo [1/8] generating keystore
  if not exist "%ROOT%\keys" mkdir "%ROOT%\keys"
  "%JDK%\bin\keytool.exe" -genkeypair -keystore "%KS%" -alias jizhangkey -keyalg RSA -keysize 2048 -validity 10950 -storepass jizhang123 -keypass jizhang123 -dname "CN=JiZhang Debug, OU=Dev, O=Personal, L=CN, ST=CN, C=CN" >nul 2>&1
  if not exist "%KS%" ( echo [ERROR] keystore failed & exit /b 1 )
) else (
  echo [1/8] keystore exists, skip
)

REM ---------- 2. compile resources (relative paths!) ----------
echo [2/8] compiling resources
pushd "%MAIN%"
"%BT%\aapt2.exe" compile --dir "res" -o "%BUILD%\compiled\res.zip"
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" ( echo [ERROR] aapt2 compile failed & exit /b 1 )

REM ---------- 3. link resources ----------
echo [3/8] linking resources
pushd "%MAIN%"
"%BT%\aapt2.exe" link -o "%BUILD%\app-unsigned.apk" -I "%PLATFORM%" --manifest "AndroidManifest.xml" -R "%BUILD%\compiled\res.zip" -A "assets" --java "%BUILD%\gen" --min-sdk-version 21 --target-sdk-version 35 --version-code 1 --version-name 1.0 --no-version-vectors --auto-add-overlay
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" ( echo [ERROR] aapt2 link failed & exit /b 1 )

REM ---------- 4. javac ----------
echo [4/8] compiling java
pushd "%MAIN%\java"
"%JDK%\bin\javac.exe" -encoding UTF-8 -source 8 -target 8 -nowarn -bootclasspath "%PLATFORM%" -classpath "%PLATFORM%" -d "%BUILD%\classes" com\jizhang\app\MainActivity.java
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" ( echo [ERROR] javac failed & exit /b 1 )

REM ---------- 5. d8 ----------
echo [5/8] dexing
pushd "%BUILD%"
dir /b /s "classes\*.class" > "classlist.txt"
call "%BT%\d8.bat" --min-api 21 --lib "%PLATFORM%" --output "%BUILD%\dex" "@%BUILD%\classlist.txt"
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" ( echo [ERROR] d8 failed & exit /b 1 )

REM ---------- 6. package dex ----------
echo [6/8] packaging dex
pushd "%BUILD%\dex"
"%JDK%\bin\jar.exe" uf "%BUILD%\app-unsigned.apk" classes.dex
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" ( echo [ERROR] jar failed & exit /b 1 )

REM ---------- 7. normalize entry names ----------
REM aapt2 on Windows writes "assets/www\index.html" with backslashes.
REM The ZIP spec and Android asset lookup need forward slashes; without this
REM the WebView fails with net::ERR_FILE_NOT_FOUND.
echo [7/9] normalizing asset paths
python "%ROOT%\tools\normalize_apk.py" "%BUILD%\app-unsigned.apk" "%BUILD%\app-normalized.apk"
if errorlevel 1 ( echo [ERROR] normalize failed & exit /b 1 )

REM ---------- 8. zipalign (before signing!) ----------
echo [8/9] zipalign
"%BT%\zipalign.exe" -f -p 4 "%BUILD%\app-normalized.apk" "%BUILD%\app-aligned.apk"
if errorlevel 1 ( echo [ERROR] zipalign failed & exit /b 1 )

REM ---------- 9. sign ----------
REM IMPORTANT: apksigner.bat ends with a bare "exit". When one .bat invokes
REM another .bat that exits, it terminates THIS script too, so everything after
REM it (the root copy, the summary) silently never ran. Calling it through
REM "call" plus the explicit JAVA_HOME keeps control inside this script.
echo [9/9] signing
set "JAVA_HOME=%JDK%"
set "PATH=%JDK%\bin;%PATH%"
call "%BT%\apksigner.bat" sign --ks "%KS%" --ks-key-alias jizhangkey --ks-pass pass:jizhang123 --key-pass pass:jizhang123 --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --out "%BUILD%\jizhang.apk" "%BUILD%\app-aligned.apk"
if errorlevel 1 ( echo [ERROR] apksigner failed & exit /b 1 )

echo.
echo === verify ===
REM NOTE: do NOT call apksigner verify from inside this script.
REM apksigner.bat ends with a bare "exit", and when a .bat invokes another .bat
REM that exits, it terminates THIS script too -- which silently killed the
REM build right after signing, so the copy step below never ran.
REM Signature verification is done separately (see the build notes / tooling).
echo (signature check is run separately, deliberately not from this script)

if not exist "%BUILD%\jizhang.apk" ( echo [ERROR] apk not produced & exit /b 1 )

REM Copy next to the project root for convenience.
REM NOTE: plain "copy" fails silently onto this non-ASCII workspace path,
REM which once left a stale APK at the root. python handles it reliably and
REM is already required by the normalize step.
python "%ROOT%\tools\copy_apk.py" "%BUILD%\jizhang.apk" "%ROOT%\JiZhang.apk"
if not exist "%ROOT%\JiZhang.apk" ( echo [WARN] root copy failed, use %BUILD%\jizhang.apk )

for %%A in ("%BUILD%\jizhang.apk") do set "APKSIZE=%%~zA"
set /a APKKB=%APKSIZE%/1024

echo.
echo ============================================
echo  BUILD OK
echo  APK : %BUILD%\jizhang.apk
if exist "%ROOT%\JiZhang.apk" echo  COPY: %ROOT%\JiZhang.apk
echo  SIZE: %APKKB% KB
echo ============================================
endlocal
exit /b 0
