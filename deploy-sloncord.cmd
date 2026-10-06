@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM Keep script ASCII-only for cmd.exe reliability.

where node >nul 2>nul
if errorlevel 1 (
  echo [Sloncord] Node.js not found in PATH. Install Node.js LTS and reopen the terminal.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [Sloncord] npm not found in PATH.
  pause
  exit /b 1
)

where dotnet >nul 2>nul
if errorlevel 1 (
  echo [Sloncord] WARNING: dotnet not in PATH. Install .NET 8 SDK ^(not only Runtime^) for API deploy.
) else (
  dotnet --list-sdks 2>nul | findstr /r "." >nul
  if errorlevel 1 (
    echo [Sloncord] WARNING: dotnet found but no SDK installed. Install .NET 8 SDK:
    echo            winget install Microsoft.DotNet.SDK.8
    echo            https://dotnet.microsoft.com/download/dotnet/8.0
  )
)

if not exist "deploy\sloncord-deploy.config.json" (
  echo [Sloncord] Missing deploy\sloncord-deploy.config.json
  echo Copy deploy\sloncord-deploy.config.example.json and fill in host, user, remote path, sshKey or sshPassword.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [Sloncord] Running npm install in repo root...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

REM Desktop build writes each package under apps/desktop/release/pkg-<time>, so a running
REM Sloncord from an older folder usually does not lock the new build output.
REM If you still see locked-file errors, close Sloncord or set SLONCORD_DEPLOY_KILL_APP=1.
tasklist /fi "imagename eq Sloncord.exe" 2>nul | find /i "Sloncord.exe" >nul
if not errorlevel 1 (
  if /i "%SLONCORD_DEPLOY_KILL_APP%"=="1" (
    echo [Sloncord] Closing running Sloncord.exe before deploy build...
    taskkill /im Sloncord.exe >nul 2>nul
    taskkill /f /im Sloncord.exe >nul 2>nul
  )
)

echo [Sloncord] Deploy: build + SFTP only files changed vs last deploy (SHA-256 manifest in deploy/).
echo          Full SFTP overwrite: npm run deploy:full
echo          Only desktop downloads: npm run deploy:desktop
echo          SFU: after wwwroot, Sfu/ is uploaded to remoteSfuRoot (see config); skip: deploySfu false or SLONCORD_DEPLOY_SKIP_SFU=1
echo          API: when deployApi true + remoteAppRoot, dotnet publish Server and SFTP to remoteAppRoot; skip: deployApi false or SLONCORD_DEPLOY_SKIP_API=1
echo          API runtime: after upload, fixes systemd unit + www-data permissions on server (apiServiceName, remoteAppRoot)
echo          After upload, restartService runs systemctl restart — API startup applies DB schema (IsAdmin, ServerBans, etc.)
echo          Requires .NET 8 SDK on this PC for dotnet publish. Your config: deployApi + restartService in deploy\sloncord-deploy.config.json
echo.
echo [Sloncord] Native helper will be built automatically via @sloncord/desktop prebuild.
echo [Sloncord] Moderation app is rebuilt on each deploy ^(Sloncord-Moderation-Setup-x64.exe^).

call npm run deploy
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" pause
exit /b %ERR%
