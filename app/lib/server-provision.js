"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { hostFromTarget } = require("./connection-config");
const { waitForHttpOk } = require("./net-wait");

// log-sump-plugin (app/log-sump-plugin, a submodule of this repo): cttc's
// own client-specific compat routes, never baked into the log-sump image
// itself (see releases/_shared/build-image.sh's own comment) -- instead
// bundled alongside the executable (see app/package.json's extraResources,
// "plugins") and bind-mounted into the container at `docker compose up`
// time, so log-sump's own image stays generic. Deploying it this way
// (rather than the git-clone-at-provision-time approach used until
// 2026-08-16) means a remote gateway host needs nothing beyond `docker`/
// `docker compose` -- no `git`, no SSH access of its own to GitHub.

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
  return resourcesDir ? path.join(resourcesDir, "log-sump.tar.gz") : path.join(defaultSharedDir(), "log-sump.tar.gz");
}
function bundledOfflineComposePath({ resourcesDir } = {}) {
  return resourcesDir
    ? path.join(resourcesDir, "docker-compose.offline.yml")
    : path.join(defaultSharedDir(), "docker-compose.yml");
}
function hasBundledTarball({ resourcesDir } = {}) {
  return fs.existsSync(bundledTarballPath({ resourcesDir }));
}

// Packaged: app/package.json's extraResources stages log-sump-plugin's
// src/ (its importable package root -- see docker-compose.yml's own
// CTTC_PLUGINS_DIR comment) as "plugins" alongside the executable.
// Dev/unpackaged: read straight out of the submodule checkout, same
// dev-fallback pattern as defaultSharedDir/defaultRepoDir above. This is
// where the plugin ships *from* -- see deployLocalPluginsDir/
// ensureRemoteContainer below for where it actually runs *from* on a
// given instance.
function bundledPluginsDir({ resourcesDir } = {}) {
  return resourcesDir
    ? path.join(resourcesDir, "plugins")
    : path.join(__dirname, "..", "log-sump-plugin", "src");
}

// ~/.cttc/ is cttc's own local app-data directory (see lib/gateway-registry.js's
// ~/.cttc/gateways.json) -- the embedded "This machine" instance's plugin
// copy lives at ~/.cttc/plugins, namespaced there rather than referencing
// bundledPluginsDir() in place, matching how a remote instance gets its
// own copy under <remoteDir>/.cttc/plugins (see ensureRemoteContainer).
function localPluginsDeployDir() {
  return path.join(os.homedir(), ".cttc", "plugins");
}

/**
 * Copies bundledPluginsDir()'s current contents to `destDir` (default
 * localPluginsDeployDir()), replacing whatever was there before (an older
 * install's plugin version, if any) -- cheap enough to redo on every
 * ensureLocalContainer call, and keeps the destination always matching
 * this install rather than whatever was first copied there. `destDir` is
 * only ever overridden by tests, to avoid touching the real
 * ~/.cttc/plugins on the machine running them.
 * @returns {string} `destDir`, once it holds a fresh copy.
 */
function deployLocalPlugins({ resourcesDir, destDir = localPluginsDeployDir() } = {}) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(bundledPluginsDir({ resourcesDir }), destDir, { recursive: true });
  return destDir;
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
 *   { type: "tarball", path: "C:\\path\\to\\log-sump.tar.gz" }
 *   { type: "registry", ref: "osteck/log-sump:0.0.2" }
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
 * matching compose file, then wait for GET /health/ready to return 200.
 * `apiToken`, when given, is passed through as CTTC_API_TOKEN -- this
 * container binds 0.0.0.0 with `network_mode: host` (see docker-compose.yml)
 * exactly like a remote gateway's, so it's reachable by anything else on
 * the LAN too, not just this machine (br-NET-004); main.js always supplies
 * the same persisted token across calls (see lib/api-token.js) so this
 * never changes between an ordinary reconnect's `docker compose up -d`
 * calls -- an env var that *did* change would make compose recreate the
 * container instead of leaving the already-running one alone. Also
 * (re-)deploys the bundled plugin to ~/.cttc/plugins (see
 * deployLocalPlugins) and passes that through as CTTC_PLUGINS_DIR, which
 * both docker-compose.yml variants bind-mount in.
 * @returns {{port: number, imageRef: string}}
 */
async function ensureLocalContainer({
  spawnFn = spawn,
  resourcesDir,
  port = 8765,
  source,
  apiToken,
  onLog,
  pluginsDestDir,
} = {}) {
  const resolved = resolveSource(source, { resourcesDir });
  const env = { ...process.env };
  if (apiToken) env.CTTC_API_TOKEN = apiToken;
  env.CTTC_PLUGINS_DIR = deployLocalPlugins({
    resourcesDir,
    ...(pluginsDestDir ? { destDir: pluginsDestDir } : {}),
  });
  if (resolved.kind === "tarball") {
    await run(spawnFn, "docker", ["load", "-i", resolved.tarballPath], {}, onLog);
  } else {
    env.CTTC_IMAGE = resolved.ref;
    await run(spawnFn, "docker", ["pull", resolved.ref], {}, onLog);
  }
  await run(spawnFn, "docker", ["compose", "-f", resolved.composeFile, "up", "-d"], { env }, onLog);
  onLog?.(`$ waiting for the container to become ready (checking http://127.0.0.1:${port}/health/ready) ...`);
  // /health/ready (not just a raw port-open check) confirms the FastAPI
  // app inside is actually up *and* has a working Redis connection, not
  // just that something is listening on the port yet -- matches
  // ensureRemoteContainer's own health check below.
  await waitForHttpOk(`http://127.0.0.1:${port}/health/ready`, {
    timeoutMs: 30000,
    ...(apiToken ? { headers: { "X-CTTC-Token": apiToken } } : {}),
  });
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
 * @param {{source?: {type: "tarball", path: string} | {type: "registry", ref: string}, apiToken?: string, onLog?: (line: string) => void}} [opts]
 * @returns {{host: string, port: number, imageRef: string}}
 */
async function ensureRemoteContainer(
  cfg,
  { spawnFn = spawn, sshBin = "ssh", scpBin = "scp", resourcesDir, source, apiToken, onLog } = {}
) {
  const remoteDir = "log-sump";
  const ssh = sshExecArgs(cfg);
  const scp = scpArgs(cfg);
  const target = cfg.sshTarget;
  const host = cfg.host || hostFromTarget(cfg.sshTarget);
  const resolved = resolveSource(source, { resourcesDir });

  await run(spawnFn, sshBin, [...ssh, `mkdir -p ${remoteDir}`], {}, onLog);

  // Copies the same private key used to reach this host into the container
  // itself, at ssh's own default identity location (~/.ssh/id_rsa) -- no
  // per-host ssh_config needed, and it works for every outbound ssh call the
  // container makes (docker -H ssh://... in "Set Sources", HostStatsSource),
  // not just ones that happen to pass an explicit ssh_key. Skipped when the
  // gateway itself was reached via agent/no explicit key -- there's nothing
  // to copy, and docker-compose.yml's ${CTTC_ID_RSA:-/dev/null} fallback
  // mounts a harmless no-op instead.
  let idRsaEnv = "";
  if (cfg.sshKey) {
    await run(spawnFn, scpBin, [...scp, cfg.sshKey, `${target}:${remoteDir}/id_rsa`], {}, onLog);
    await run(spawnFn, sshBin, [...ssh, `chmod 600 ${remoteDir}/id_rsa`], {}, onLog);
    idRsaEnv = 'CTTC_ID_RSA="$PWD/id_rsa" ';
  }
  // br-NET-004: this container binds 0.0.0.0 with network_mode: host (see
  // docker-compose.yml), reachable by anything else that can reach this
  // host, not just this client -- CTTC_API_TOKEN gates server.py's own
  // auth middleware behind it. main.js always supplies the same persisted
  // token across calls (lib/api-token.js), so this never changes between
  // an ordinary reconnect's `docker compose up -d` calls -- an env var
  // that did change would make compose recreate the container instead of
  // leaving the already-running, already-authenticated one alone.
  const apiTokenEnv = apiToken ? `CTTC_API_TOKEN=${apiToken} ` : "";

  // Copies the bundled plugins directory (see bundledPluginsDir's own
  // docstring) up to the remote host itself, under .cttc/ -- namespaces
  // cttc's own addition separately from log-sump's native files sitting
  // directly in ${remoteDir} (docker-compose.yml, the tarball, id_rsa),
  // mirroring ~/.cttc/ as cttc's own app-data convention on the local
  // side (see localPluginsDeployDir). Cleaned first so a plugin file
  // removed since the last deploy doesn't linger (plain `scp -r` onto an
  // existing directory only overwrites/adds, never deletes). Requires
  // nothing beyond `docker`/`docker compose` on the remote host: no
  // `git`, no SSH access of its own to GitHub, unlike the
  // git-clone-at-provision-time approach this replaced. `$PWD` (not a
  // literal path) for the same reason idRsaEnv uses it below: this whole
  // thing runs as one shell invocation after `cd ${remoteDir}`, so `$PWD`
  // is already that absolute directory by the time docker compose reads
  // CTTC_PLUGINS_DIR from it.
  await run(spawnFn, sshBin, [...ssh, `rm -rf ${remoteDir}/.cttc/plugins && mkdir -p ${remoteDir}/.cttc`], {}, onLog);
  await run(
    spawnFn,
    scpBin,
    [...scp, "-r", bundledPluginsDir({ resourcesDir }), `${target}:${remoteDir}/.cttc/plugins`],
    {},
    onLog
  );
  const pluginsDirEnv = 'CTTC_PLUGINS_DIR="$PWD/.cttc/plugins" ';

  if (resolved.kind === "tarball") {
    await run(spawnFn, scpBin, [...scp, resolved.tarballPath, `${target}:${remoteDir}/`], {}, onLog);
    await run(spawnFn, scpBin, [...scp, resolved.composeFile, `${target}:${remoteDir}/docker-compose.yml`], {}, onLog);
    await run(spawnFn, sshBin, [
      ...ssh,
      `cd ${remoteDir} && docker load -i ${path.basename(resolved.tarballPath)} && ${apiTokenEnv}${idRsaEnv}${pluginsDirEnv}docker compose -f docker-compose.yml up -d`,
    ], {}, onLog);
  } else {
    await run(spawnFn, scpBin, [...scp, resolved.composeFile, `${target}:${remoteDir}/docker-compose.yml`], {}, onLog);
    await run(spawnFn, sshBin, [
      ...ssh,
      `cd ${remoteDir} && docker pull ${resolved.ref} && CTTC_IMAGE=${resolved.ref} ${apiTokenEnv}${idRsaEnv}${pluginsDirEnv}docker compose -f docker-compose.yml up -d`,
    ], {}, onLog);
  }

  onLog?.(`$ waiting for the container to come up (checking http://${host}:${cfg.remotePort}/health/ready) ...`);
  try {
    await waitForHttpOk(`http://${host}:${cfg.remotePort}/health/ready`, {
      timeoutMs: 30000,
      ...(apiToken ? { headers: { "X-CTTC-Token": apiToken } } : {}),
    });
  } catch (err) {
    onLog?.(`  → not reachable directly yet (${err.message || err}) -- setting ssh tunnel instead`);
  }
  return { host, port: cfg.remotePort, imageRef: resolved.imageRef };
}

/**
 * Stops and removes the local gateway container *and* its image (Edit
 * Gateways' Uninstall, for a local-docker entry) -- `--rmi all` extends
 * `docker compose down`'s default scope (container + network only) to also
 * drop the image, so a re-install pulls/loads it fresh rather than silently
 * reusing whatever's still cached. `source` must be the same one the
 * gateway was actually provisioned with (main.js persists it on the
 * registry entry as `imageSource` right after a successful
 * ensureLocalContainer, precisely so uninstall can pass it back in here) --
 * resolving with no source always picks the bundled-tarball/offline compose
 * regardless of what's actually running (br-PROV-007), so a gateway
 * provisioned from a custom registry ref (via Settings > "Update server
 * image") got `--rmi all`'d against the wrong image name, leaving the real
 * one behind while reporting success.
 */
async function uninstallLocalContainer({ spawnFn = spawn, resourcesDir, source, onLog } = {}) {
  const resolved = resolveSource(source, { resourcesDir });
  await run(spawnFn, "docker", ["compose", "-f", resolved.composeFile, "down", "--rmi", "all"], {}, onLog);
}

/**
 * Stops and removes a remote gateway container *and* its image over ssh
 * (see uninstallLocalContainer above for why `--rmi all`), then deletes the
 * remoteDir ensureRemoteContainer created it in (the tarball/compose file
 * copied there have no further use once uninstalled).
 * @param {{sshTarget: string, sshKey: string|null, sshPort?: number}} cfg
 */
async function uninstallRemoteContainer(cfg, { spawnFn = spawn, sshBin = "ssh", onLog } = {}) {
  const remoteDir = "log-sump";
  const ssh = sshExecArgs(cfg);
  await run(
    spawnFn,
    sshBin,
    [...ssh, `cd ${remoteDir} && docker compose down --rmi all; cd "$HOME" && rm -rf ${remoteDir}`],
    {},
    onLog
  );
}

// Best-effort post-mortem for a failed uninstall: reports (via onLog,
// non-fatal either way) whether the container is actually still there --
// `docker compose down` can exit non-zero after partially succeeding, so a
// reported error doesn't necessarily mean nothing happened. Never throws:
// this is diagnostic information for the activity log, not a result the
// caller should have to handle failing itself.
async function checkStillInstalled(entry, { spawnFn = spawn, resourcesDir, sshBin = "ssh", onLog } = {}) {
  onLog?.("$ checking whether the container is still there...");
  try {
    if (entry.mode === "embedded") {
      // br-PROV-007: same fix as uninstallLocalContainer -- must resolve
      // against what this entry was actually provisioned with, not the
      // bundled/default source, or this post-mortem inspects the wrong
      // compose file's containers.
      const resolved = resolveSource(entry.imageSource, { resourcesDir });
      await run(spawnFn, "docker", ["compose", "-f", resolved.composeFile, "ps", "-a"], {}, onLog);
    } else {
      const ssh = sshExecArgs({ sshTarget: entry.sshTarget, sshKey: entry.sshKey, sshPort: entry.sshPort });
      await run(spawnFn, sshBin, [...ssh, "cd log-sump && docker compose ps -a"], {}, onLog);
    }
  } catch (err) {
    onLog?.(`  could not check: ${err.message}`);
  }
}

module.exports = {
  bundledTarballPath,
  bundledOfflineComposePath,
  bundledPluginsDir,
  localPluginsDeployDir,
  deployLocalPlugins,
  hasBundledTarball,
  readImageRef,
  registryComposePath,
  ensureLocalContainer,
  ensureRemoteContainer,
  uninstallLocalContainer,
  uninstallRemoteContainer,
  checkStillInstalled,
};
