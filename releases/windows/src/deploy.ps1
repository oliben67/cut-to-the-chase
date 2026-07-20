<#
CTTC Windows deployment script.

This is a full deployment, not a dev test harness: it (1) installs the real
packaged CTTC client on *this* Windows machine -- no Node.js/npm/Docker/
Python needed here at all -- and (2) ships a pre-built server image
(image/cttc-server.tar.gz, built with `docker build` + `docker save`, not
server sources) to the remote Docker-enabled host over SSH, `docker load`s
it there and brings it up with `docker compose`, then (3) points the
installed client at that container over an SSH tunnel. Nothing gets built
on the remote host -- it only ever loads an already-built image.
See docs/architecture/remote-server.md in the main repo for the design.

Usage: right-click this file -> "Run with PowerShell", or from a PowerShell
prompt:
  powershell -ExecutionPolicy Bypass -File .\deploy.ps1
  powershell -ExecutionPolicy Bypass -File .\deploy.ps1 `
    -SshTarget deploy@docker-host.example.com -SshKey C:\keys\id_ed25519 `
    -RemoteDir cttc-server -RemotePort 8765

Every parameter is optional and falls back to a bundled default -- pass
-SshTarget (and, if it's not the bundled deploy key, -SshKey) to point this
same bundle at a different Docker-enabled host without editing the script.
#>

param(
  [string]$SshTarget = "oliviersteck@192.168.1.138",
  [string]$SshKey,
  [string]$RemoteDir = "cttc-server",       # relative to that account's home dir
  [int]$RemotePort = 8765
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$installerPath = Join-Path $root "CTTC Setup.exe"
$imageTar = Join-Path $root "image\cttc-server.tar.gz"
$composeFile = Join-Path $root "image\docker-compose.yml"
$cttcDir = Join-Path $env:USERPROFILE ".cttc"
$configPath = Join-Path $cttcDir "connection.json"

# -- deployment target: the Docker-enabled host that runs the server
# container. Override via -SshTarget/-SshKey/-RemoteDir/-RemotePort instead
# of editing this file; $keyPath defaults to the bundled deploy key unless
# -SshKey points at a different one (e.g. a key for a different host).
$sshTarget = $SshTarget
$remoteDir = $RemoteDir
$remotePort = $RemotePort
$keyPath = if ($SshKey) { $SshKey } else { Join-Path $root "keys\cttc_deploy" }

function Fail($msg) {
  Write-Host ""
  Write-Host "ERROR: $msg" -ForegroundColor Red
  Write-Host ""
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "== CTTC Windows deployment ==" -ForegroundColor Cyan

# 1) prerequisites: only ssh/scp are needed on this machine -----------------
$ssh = Get-Command ssh -ErrorAction SilentlyContinue
$scp = Get-Command scp -ErrorAction SilentlyContinue
if (-not $ssh -or -not $scp) {
  Fail ("OpenSSH client (ssh/scp) not found on PATH. On Windows 10/11 it's normally a " +
        "Windows feature: Settings -> Apps -> Optional features -> Add a feature -> " +
        """OpenSSH Client"" (or, as Administrator: Add-WindowsCapability -Online -Name " +
        "OpenSSH.Client~~~~0.0.1.0), then re-run this script.")
}
Write-Host "ssh: $($ssh.Source)"

if (-not (Test-Path $installerPath)) {
  Fail "Installer not found at '$installerPath' -- the bundle may be incomplete. Build it with 'npm run dist:win' in app/."
}
if (-not (Test-Path $imageTar)) {
  Fail "Server image not found at '$imageTar' -- the bundle may be incomplete. Build it with 'docker build' + 'docker save' (see app/server/README or docs/architecture/remote-server.md)."
}
if (-not (Test-Path $composeFile)) {
  Fail "Compose file not found at '$composeFile' -- the bundle may be incomplete."
}
if (-not (Test-Path $keyPath)) {
  Fail "Deployment SSH key not found at '$keyPath' -- the bundle may be incomplete."
}

# 2) fix the private key's permissions ---------------------------------------
# Windows' OpenSSH client refuses a private key that isn't restricted to the
# current user only (its equivalent of `chmod 600`).
Write-Host "Restricting key file permissions to the current user..."
icacls $keyPath /inheritance:r | Out-Null
icacls $keyPath /grant:r "$($env:USERNAME):(R)" | Out-Null

# 3) deploy/update the server container on the remote host ------------------
# Ships the *pre-built* image (docker load, not docker compose --build) and
# the deploy compose file up every run, so the remote side always runs
# whatever image this bundle was built with rather than silently drifting
# from it -- and never needs a Docker build toolchain, server sources, or
# network egress to pull base images. docker-compose.yml (the deploy
# variant, no `build:` key) already encodes pid:host + network_mode:host +
# the docker.sock mount -- nothing Windows-side needs to know about any of
# that.
Write-Host ""
Write-Host "Shipping server image to $sshTarget ..." -ForegroundColor Cyan
& $ssh.Source -i $keyPath -o StrictHostKeyChecking=accept-new $sshTarget "mkdir -p $remoteDir"
if ($LASTEXITCODE -ne 0) { Fail "could not create '$remoteDir' on $sshTarget (see output above)." }
& $scp.Source -i $keyPath -o StrictHostKeyChecking=accept-new $imageTar $composeFile "${sshTarget}:${remoteDir}/"
if ($LASTEXITCODE -ne 0) { Fail "scp of the server image/compose file to $sshTarget failed (see output above)." }

Write-Host "Loading image and starting the container on $sshTarget ..." -ForegroundColor Cyan
& $ssh.Source -i $keyPath -o StrictHostKeyChecking=accept-new $sshTarget `
  "cd $remoteDir && docker load -i cttc-server.tar.gz && docker compose up -d"
if ($LASTEXITCODE -ne 0) { Fail "remote 'docker load' / 'docker compose up -d' on $sshTarget failed (see output above)." }
Write-Host "Server container is up on $sshTarget."

# 4) write ~/.cttc/connection.json -------------------------------------------
New-Item -ItemType Directory -Force -Path $cttcDir | Out-Null
$config = @{
  mode        = "ssh-tunnel"
  ssh_target  = $sshTarget
  ssh_key     = $keyPath
  remote_port = $remotePort
} | ConvertTo-Json

# Windows PowerShell's -Encoding UTF8 writes a byte-order-mark; Node's
# JSON.parse() does not strip a leading BOM and would fail to parse this
# file with a cryptic "invalid JSON" error. Write BOM-less UTF-8 explicitly.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($configPath, $config, $utf8NoBom)
Write-Host "Wrote $configPath"

# 5) install the real client (no Node/npm on this machine at all) -----------
# Silent install (re-runs cleanly if CTTC is already installed -- NSIS
# updates in place). This is the packaged Electron app built via
# 'npm run dist:win' (electron-builder / NSIS) in app/, not a source checkout.
Write-Host ""
Write-Host "Installing CTTC client..." -ForegroundColor Cyan
$proc = Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait -PassThru
if ($proc.ExitCode -ne 0) { Fail "CTTC installer exited with code $($proc.ExitCode)." }

# 6) launch it ----------------------------------------------------------------
# The installer creates fixed shortcut locations regardless of the (optional,
# user-selectable) install directory, so launch via the Start Menu shortcut
# rather than guessing where CTTC.exe ended up.
$shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\CTTC.lnk"
if (-not (Test-Path $shortcut)) { Fail "Install finished but shortcut not found at $shortcut." }
Write-Host "Starting CTTC -- connecting to $sshTarget over SSH..." -ForegroundColor Cyan
Start-Process -FilePath $shortcut
