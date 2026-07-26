"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { hostFromTarget } = require("./connection-config");
const { waitForPortOpen, waitForHttpOk } = require("./net-wait");

// The server image tarball + both docker-compose variants ship as
// electron-builder extraResources (see app/package.json's
// "build.extraResources") -- baked into the installer at build time by
// releases/_shared/build-image.sh + each platform's build-bundle.sh, which
// build+save the image *before* `npm run dist:{win,mac,linux}` packages it
// in. Nothing needs staging by any install-time script: the running app
// just reads its own resources directory. resourcesDir lets main.js pass
// process.resourcesPath when packaged; the defaults here are the
// dev/unpackaged fallback (read straight out of the checked-out releases/
// tree) -- the image tarball itself is shared across all three platforms
// (releases/_shared/), while image.json/the registry compose file live in
// releases/_repo/ (also shared -- it's the same registry image regardless
// of the client's host OS).
function defaultSharedDir() {
  return path.join(__dirname, "..", "..", "releases", "_shared");
}
function defaultRepoDir() {
  return path.join(__dirname, "..", "..", "releases", "_repo");
}

function bundledTarballPath({ resourcesDir } = {}) {
  return resourcesDir ? path.join(resourcesDir, "cttc-gateway.tar.gz") : path.join(defaultSharedDir(), "cttc-gateway.tar.gz");
}
function bundledOfflineComposePath({ resourcesDir } = {}) {
  return resourcesDir
    ? path.join(resourcesDir, "docker-compose.offline.yml")
    : path.join(defaultSharedDir(), "docker-compose.yml");
}
function hasBundledTarball({ resourcesDir } = {}) {
  return fs.existsSync(bundledTarballPath({ resourcesDir }));
}

/**
 * Reads image.json: {image, tag} identifying the registry image to `docker
 * pull` when there's no bundled tarball (there always should be one once a
 * release is built via build-bundle.sh -- this is the fallback for, e.g., a
 * dev checkout that hasn't built one locally). releases/_shared/build-image.sh
 * tags + pushes to this ref on every release build (best-effort -- it's not
 * the app's default path, see server-provision.js's module doc, but is kept
 * live rather than left as a dead placeholder).
 */
function readImageRef({ resourcesDir } = {}) {
  const p = resourcesDir ? path.join(resourcesDir, "image.json") : path.join(defaultRepoDir(), "image.json");
  const { image, tag } = JSON.parse(fs.readFileSync(p, "utf8"));
  return { image, tag, ref: `${image}:${tag}` };
}

function registryComposePath({ resourcesDir } = {}) {
  return resourcesDir
    ? path.join(resourcesDir, "docker-compose.registry.yml")
    : path.join(defaultRepoDir(), "docker-compose.yml");
}

function run(spawnFn, cmd, args, opts = {}, onLog) {
  const line = `${cmd} ${args.join(" ")}`;
  onLog?.(`$ ${line}`);
  return new Promise((resolve, reject) => {
    const proc = spawnFn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d; onLog?.(String(d)); });
    proc.on("error", (err) => {
      onLog?.(`  error: ${err.message}`);
      reject(new Error(`could not run ${cmd}: ${err.message}`));
    });
    proc.on("exit", (code) => {
      if (code === 0) {
        onLog?.(`  → exit 0`);
        resolve();
      } else {
        onLog?.(`  → exit ${code}`);
        reject(new Error(`${cmd} ${args.join(" ")} exited (code ${code}): ${stderr.trim() || "no output"}`));
      }
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
 * handler) explicitly overrides the default of "whatever's bundled":
 *   { type: "tarball", path: "C:\\path\\to\\cttc-gateway.tar.gz" }
 *   { type: "registry", ref: "osteck/cttc-gateway:0.0.2" }
 * With no override: prefers the tarball baked into this install,
 * falling back to image.json's registry ref (a placeholder until a real
 * registry is wired up).
 */
function resolveSource(source, { resourcesDir } = {}) {
  // imageRef is a best-effort human-readable label for "what version is
  // this" -- recorded against the gateway registry entry (see
  // lib/gateway-registry.js) so Edit Gateways/the status dropdown can show
  // it. A custom tarball has no version string to read without unpacking
  // it, so it's labeled by filename instead of left blank.
  if (source?.type === "tarball") {
    return {
      kind: "tarball",
      tarballPath: source.path,
      composeFile: bundledOfflineComposePath({ resourcesDir }),
      imageRef: path.basename(source.path),
    };
  }
  if (source?.type === "registry") {
    return { kind: "registry", ref: source.ref, composeFile: registryComposePath({ resourcesDir }), imageRef: source.ref };
  }
  if (hasBundledTarball({ resourcesDir })) {
    let imageRef = "bundled tarball";
    try {
      imageRef = readImageRef({ resourcesDir }).ref;
    } catch {
      /* image.json missing in this checkout -- keep the generic label */
    }
    return {
      kind: "tarball",
      tarballPath: bundledTarballPath({ resourcesDir }),
      composeFile: bundledOfflineComposePath({ resourcesDir }),
      imageRef,
    };
  }
  const ref = readImageRef({ resourcesDir }).ref;
  return { kind: "registry", ref, composeFile: registryComposePath({ resourcesDir }), imageRef: ref };
}

/**
 * Gets the server container running on *this* machine: docker-load or
 * docker-pull per resolveSource(), then `docker compose up -d` with the
 * matching compose file, then wait for the fixed container port to open.
 * @returns {{port: number, imageRef: string}}
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
  return { port, imageRef: resolved.imageRef };
}

/**
 * Gets the server container running on a *remote* Docker-enabled host over
 * ssh: scp's up the tarball+compose (offline path) or just the compose file
 * (registry path), execs the equivalent docker load/pull + compose up
 * there. ssh is only used here for provisioning -- the client normally
 * talks to the running container directly over plain HTTP afterwards, no
 * tunnel/port-forward -- but whether that direct path is actually reachable
 * (vs. needing an ssh -L fallback) is a call this function deliberately
 * leaves to its caller (see main.js's connectRemoteGateway): the health
 * check below is a best-effort "is it up at all yet" wait, not a hard
 * requirement -- a false negative here (reachable only via ssh, not
 * directly) shouldn't fail provisioning, since the container itself is
 * genuinely fine either way.
 * @param {{sshTarget: string, sshKey: string|null, sshPort?: number, remotePort: number, host?: string}} cfg
 * @param {{source?: {type: "tarball", path: string} | {type: "registry", ref: string}, onLog?: (line: string) => void}} [opts]
 * @returns {{host: string, port: number, imageRef: string}}
 */
async function ensureRemoteContainer(cfg, { spawnFn = spawn, sshBin = "ssh", scpBin = "scp", resourcesDir, source, onLog } = {}) {
  const remoteDir = "cttc-gateway";
  const ssh = sshExecArgs(cfg);
  const scp = scpArgs(cfg);
  const target = cfg.sshTarget;
  const host = cfg.host || hostFromTarget(cfg.sshTarget);
  const resolved = resolveSource(source, { resourcesDir });

  await run(spawnFn, sshBin, [...ssh, `mkdir -p ${remoteDir}`], {}, onLog);

  if (resolved.kind === "tarball") {
    await run(spawnFn, scpBin, [...scp, resolved.tarballPath, `${target}:${remoteDir}/`], {}, onLog);
    await run(spawnFn, scpBin, [...scp, resolved.composeFile, `${target}:${remoteDir}/docker-compose.yml`], {}, onLog);
    await run(spawnFn, sshBin, [
      ...ssh,
      `cd ${remoteDir} && docker load -i ${path.basename(resolved.tarballPath)} && docker compose -f docker-compose.yml up -d`,
    ], {}, onLog);
  } else {
    await run(spawnFn, scpBin, [...scp, resolved.composeFile, `${target}:${remoteDir}/docker-compose.yml`], {}, onLog);
    await run(spawnFn, sshBin, [
      ...ssh,
      `cd ${remoteDir} && docker pull ${resolved.ref} && CTTC_IMAGE=${resolved.ref} docker compose -f docker-compose.yml up -d`,
    ], {}, onLog);
  }

  onLog?.(`$ waiting for the container to come up (checking http://${host}:${cfg.remotePort}/health) ...`);
  try {
    await waitForHttpOk(`http://${host}:${cfg.remotePort}/health`, { timeoutMs: 30000 });
  } catch (err) {
    onLog?.(`  → not reachable directly yet (${err.message || err}) -- caller will decide on an ssh tunnel`);
  }
  return { host, port: cfg.remotePort, imageRef: resolved.imageRef };
}

/**
 * Stops and removes the local gateway container (Edit Gateways' Uninstall,
 * for the "This machine" entry). Leaves the image itself alone -- just the
 * container/network compose created, matching `docker compose down`'s
 * default scope.
 */
async function uninstallLocalContainer({ spawnFn = spawn, resourcesDir } = {}) {
  const resolved = resolveSource(undefined, { resourcesDir });
  await run(spawnFn, "docker", ["compose", "-f", resolved.composeFile, "down"]);
}

/**
 * Stops and removes a remote gateway container over ssh, then deletes the
 * remoteDir ensureRemoteContainer created it in (the tarball/compose file
 * copied there have no further use once uninstalled).
 * @param {{sshTarget: string, sshKey: string|null, sshPort?: number}} cfg
 */
async function uninstallRemoteContainer(cfg, { spawnFn = spawn, sshBin = "ssh", onLog } = {}) {
  const remoteDir = "cttc-gateway";
  const ssh = sshExecArgs(cfg);
  await run(
    spawnFn,
    sshBin,
    [...ssh, `cd ${remoteDir} && docker compose down; cd "$HOME" && rm -rf ${remoteDir}`],
    {},
    onLog
  );
}

module.exports = {
  bundledTarballPath,
  bundledOfflineComposePath,
  hasBundledTarball,
  readImageRef,
  registryComposePath,
  ensureLocalContainer,
  ensureRemoteContainer,
  uninstallLocalContainer,
  uninstallRemoteContainer,
};
