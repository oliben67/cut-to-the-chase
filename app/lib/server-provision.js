"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { startTunnel, waitForPortOpen } = require("./ssh-tunnel");

// Where prepare-image.ps1 (releases/windows) stages the offline-built image
// tarball + its docker-compose.yml for CTTC to pick up on first run.
function offlineImageDir() {
  return path.join(os.homedir(), ".cttc", "offline-image");
}
function offlineTarballPath() {
  return path.join(offlineImageDir(), "cttc-server.tar.gz");
}
function offlineComposePath() {
  return path.join(offlineImageDir(), "docker-compose.yml");
}
function hasOfflineImage() {
  return fs.existsSync(offlineTarballPath());
}

// releases/windows/repo/{image.json,docker-compose.yml} get bundled as
// electron-builder extraResources (see app/package.json's "build.extraResources")
// -- resourcesPath lets tests/dev point this at the checked-out repo copy instead.
function defaultRepoDir() {
  return path.join(__dirname, "..", "..", "releases", "windows", "repo");
}

/**
 * Reads image.json: {image, tag} identifying the registry image to `docker
 * pull` when there's no offline tarball staged. NOTE: as of writing this
 * points at a placeholder -- no image has actually been published there
 * yet. hasOfflineImage() is checked first everywhere below specifically so
 * that doesn't matter until a real registry is wired up.
 */
function readImageRef({ resourcesDir } = {}) {
  const p = path.join(resourcesDir || defaultRepoDir(), "image.json");
  const { image, tag } = JSON.parse(fs.readFileSync(p, "utf8"));
  return { image, tag, ref: `${image}:${tag}` };
}

function repoComposePath({ resourcesDir } = {}) {
  return path.join(resourcesDir || defaultRepoDir(), "docker-compose.yml");
}

function run(spawnFn, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnFn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d; });
    proc.on("error", (err) => reject(new Error(`could not run ${cmd}: ${err.message}`)));
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited (code ${code}): ${stderr.trim() || "no output"}`));
    });
  });
}

function sshExecArgs({ sshTarget, sshKey, sshPort }) {
  const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];
  if (sshKey) args.push("-i", sshKey, "-o", "IdentitiesOnly=yes");
  if (sshPort) args.push("-p", String(sshPort));
  args.push(sshTarget);
  return args;
}

function scpArgs({ sshKey, sshPort }) {
  const args = [];
  if (sshKey) args.push("-i", sshKey);
  if (sshPort) args.push("-P", String(sshPort)); // scp: uppercase -P, unlike ssh's -p
  return args;
}

/**
 * Resolves what image to run and which compose file goes with it. `source`
 * (from Settings > "Update server image", see main.js's "update-image"
 * handler) explicitly overrides the default of "whatever's staged/bundled":
 *   { type: "tarball", path: "C:\\path\\to\\cttc-server.tar.gz" }
 *   { type: "registry", ref: "ghcr.io/oliben67/cttc-server:0.0.2" }
 * With no override: prefers the offline tarball prepare-image.ps1 staged,
 * falling back to image.json's registry ref (a placeholder until a real
 * registry is wired up).
 */
function resolveSource(source, { resourcesDir } = {}) {
  if (source?.type === "tarball") {
    return { kind: "tarball", tarballPath: source.path, composeFile: offlineComposePath() };
  }
  if (source?.type === "registry") {
    return { kind: "registry", ref: source.ref, composeFile: repoComposePath({ resourcesDir }) };
  }
  if (hasOfflineImage()) {
    return { kind: "tarball", tarballPath: offlineTarballPath(), composeFile: offlineComposePath() };
  }
  return { kind: "registry", ref: readImageRef({ resourcesDir }).ref, composeFile: repoComposePath({ resourcesDir }) };
}

/**
 * Gets the server container running on *this* machine: docker-load or
 * docker-pull per resolveSource(), then `docker compose up -d` with the
 * matching compose file, then wait for the fixed container port to open.
 * @returns {{port: number}}
 */
async function ensureLocalContainer({ spawnFn = spawn, resourcesDir, port = 8765, source } = {}) {
  const resolved = resolveSource(source, { resourcesDir });
  const env = { ...process.env };
  if (resolved.kind === "tarball") {
    await run(spawnFn, "docker", ["load", "-i", resolved.tarballPath]);
  } else {
    env.CTTC_IMAGE = resolved.ref;
    await run(spawnFn, "docker", ["pull", resolved.ref]);
  }
  await run(spawnFn, "docker", ["compose", "-f", resolved.composeFile, "up", "-d"], { env });
  await waitForPortOpen("127.0.0.1", port, { timeoutMs: 30000 });
  return { port };
}

/**
 * Gets the server container running on a *remote* Docker-enabled host over
 * ssh: scp's up the tarball+compose (offline path) or just the compose file
 * (registry path), execs the equivalent docker load/pull + compose up
 * there, then opens the usual ssh-tunnel port-forward to it.
 * @param {{sshTarget: string, sshKey: string|null, sshPort?: number, remotePort: number}} cfg
 * @param {{source?: {type: "tarball", path: string} | {type: "registry", ref: string}}} [opts]
 */
async function ensureRemoteContainer(cfg, { spawnFn = spawn, sshBin = "ssh", scpBin = "scp", resourcesDir, source } = {}) {
  const remoteDir = "cttc-server";
  const ssh = sshExecArgs(cfg);
  const scp = scpArgs(cfg);
  const target = cfg.sshTarget;
  const resolved = resolveSource(source, { resourcesDir });

  await run(spawnFn, sshBin, [...ssh, `mkdir -p ${remoteDir}`]);

  if (resolved.kind === "tarball") {
    await run(spawnFn, scpBin, [...scp, resolved.tarballPath, resolved.composeFile, `${target}:${remoteDir}/`]);
    await run(spawnFn, sshBin, [
      ...ssh,
      `cd ${remoteDir} && docker load -i ${path.basename(resolved.tarballPath)} && docker compose -f docker-compose.yml up -d`,
    ]);
  } else {
    await run(spawnFn, scpBin, [...scp, resolved.composeFile, `${target}:${remoteDir}/docker-compose.yml`]);
    await run(spawnFn, sshBin, [
      ...ssh,
      `cd ${remoteDir} && docker pull ${resolved.ref} && CTTC_IMAGE=${resolved.ref} docker compose -f docker-compose.yml up -d`,
    ]);
  }

  return startTunnel(cfg, { spawnFn, sshBin });
}

module.exports = {
  offlineImageDir,
  offlineTarballPath,
  offlineComposePath,
  hasOfflineImage,
  readImageRef,
  repoComposePath,
  ensureLocalContainer,
  ensureRemoteContainer,
};
