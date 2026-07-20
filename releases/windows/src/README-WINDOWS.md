# CTTC — Windows deployment bundle

Installs the real CTTC client on this Windows machine (no Node.js, npm,
Docker, or Python needed here) and deploys a **pre-built** CTTC server
image to a remote Docker-enabled host over SSH — no build happens on the
remote host, it only `docker load`s an already-built image — then points
the installed client at that container through an SSH tunnel. Background:
[docs/architecture/remote-server.md](https://github.com/oliben67/cut-to-the-chase/blob/feature/remote-server-ssh-tunnel/docs/architecture/remote-server.md).

## What's in this folder

```
CTTC Setup.exe            the packaged Electron client (built via
                          `npm run dist:win` in app/, using
                          electron-builder/NSIS) -- a real installer, not
                          a source checkout
image/cttc-server.tar.gz  the server image, pre-built and `docker save`d
                          (see "Rebuilding the image" below) -- shipped as
                          a binary artifact, not source
image/docker-compose.yml  deploy-only compose file (no `build:` context;
                          references the loaded image directly)
keys/cttc_deploy          SSH keypair authorized on the target host for
                          this deploy
deploy.ps1                does everything below in one step
README-WINDOWS.md         this file
```

## Prerequisites

- **OpenSSH client** (`ssh`/`scp`) — ships with Windows 10 (1809+)/11,
  usually already enabled. `deploy.ps1` checks for this and tells you if
  it's missing: Settings → Apps → Optional features → Add a feature →
  "OpenSSH Client" (or, as Administrator:
  `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0`).
- A reachable Docker-enabled host that the bundled key is authorized on.
  The default target (`oliviersteck@192.168.1.138`) is a parameter, not a
  hardcoded value — pass `-SshTarget`/`-SshKey`/`-RemoteDir`/`-RemotePort`
  to point this same bundle at a different host without editing the script
  (see below).
- Nothing else. No Node.js, no Docker Desktop, no Python/`uv` on this
  Windows machine — that's the point of this deployment model.

## Run it

Right-click **`deploy.ps1`** → **Run with PowerShell** to deploy to the
bundled default host. To target a different Docker-enabled host, run it
from a PowerShell prompt with parameters instead:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 `
  -SshTarget deploy@docker-host.example.com `
  -SshKey C:\keys\id_ed25519 `
  -RemoteDir cttc-server `
  -RemotePort 8765
```

All four parameters are optional; any omitted one falls back to the
bundled default (`-SshKey` falls back to the bundled `keys\cttc_deploy`,
which is only valid against the default host — always pass `-SshKey` when
overriding `-SshTarget` unless that key is authorized on the new host
too). (If Windows blocks the script as unsigned, the `-ExecutionPolicy
Bypass` form above is the fix either way.)

It will, every time it's run:

1. Check `ssh`/`scp` are on `PATH`; lock down the bundled private key's file
   permissions to the current user only (Windows OpenSSH refuses a key
   that isn't restricted this way).
2. `scp` `image/cttc-server.tar.gz` + `image/docker-compose.yml` to the
   remote host, then over `ssh` run `docker load -i cttc-server.tar.gz`
   followed by `docker compose up -d` — deploys or updates the server
   container to whatever image this bundle ships, rather than assuming a
   container is already running or building anything remotely.
3. Write `%USERPROFILE%\.cttc\connection.json` in `ssh-tunnel` mode pointing
   at that host.
4. Silently install/update **CTTC Setup.exe** (`/S`) — a real Windows
   install, with Start Menu/Desktop shortcuts, no `npm install` involved.
5. Launch CTTC from its Start Menu shortcut. It connects through the SSH
   tunnel and behaves identically to a local install; **＋ Add sources**
   lists the real containers running on the remote host.

## Rebuilding the installer

From `app/` in the main repo:

```sh
npm install
npm run dist:win        # -> app/dist/CTTC Setup <version>.exe (NSIS installer)
npm run dist:win:zip    # -> app/dist/CTTC-<version>-win.zip (unpacked, no installer)
```

electron-builder cross-builds the Windows target from macOS/Linux without
needing Wine (it ships its own `makensis`/`7z` toolchain) — no Windows
machine is required to produce the installer, only to run it.

## Rebuilding the server image

From `app/server/` in the main repo, against any Docker context (does not
need to be the deploy target itself — build locally, ship the resulting
binary):

```sh
docker build -t cttc-server:latest .
docker save cttc-server:latest | gzip > cttc-server.tar.gz
```

Drop the resulting `cttc-server.tar.gz` into this bundle's `image/`
directory (alongside the unchanged `docker-compose.yml`) before re-zipping.

## Cleanup

The bundled key is scoped to this deployment. To revoke it, on the server:
```sh
ssh <target host>
# edit ~/.ssh/authorized_keys and remove the matching line
```
To remove the remote container:
`ssh <target host> "cd <remoteDir> && docker compose down"`.
