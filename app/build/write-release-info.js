#!/usr/bin/env node
// Writes build/release-info.json (see package.json's `build.extraResources`,
// which ships it next to the executable) with the exact release tag this
// build will be published under -- so Help > About can show the real
// shipped identifier (e.g. "0.2.0-win4"), not just the bare semver every
// build shares regardless of platform or how many times it's been cut.
//
// Always runs as a predist:* hook (like build:manual), so it -- and
// therefore the file electron-builder's extraResources expects -- exists
// for *any* packaging invocation, not just the full release pipeline
// (app/Taskfile.yml's build:release:<platform>, which passes a real
// -win/-mac/-linux suffix after releases/_shared/bump-release-num.sh has
// already bumped release-num.txt). Run with no suffix, or with one but no
// bumped release-num.txt yet (e.g. testing `npm run dist:win` directly),
// this falls back to a "-dev" tag instead of failing the build -- gitignored,
// generated fresh every run, same as CTTC-Manual.html.
//
// Usage: node build/write-release-info.js [tag-suffix]
//   tag-suffix   e.g. -win, -mac, -linux -- same platform matrix
//                publish-release.sh uses, so a real release build's tag
//                matches exactly what that script will publish moments
//                later. Omit for a dev build (npm start's prestart).
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const APP_DIR = path.join(__dirname, "..");
const RELEASES_ROOT = path.join(APP_DIR, "..", "releases");
const OUT = path.join(__dirname, "release-info.json");

const suffix = process.argv[2] || null;
const { version } = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8"));

const releaseNumPath = path.join(RELEASES_ROOT, "release-num.txt");
const n = suffix && fs.existsSync(releaseNumPath)
  ? fs.readFileSync(releaseNumPath, "utf8").trim()
  : null;

const tag = n !== null ? `${version}${suffix}${n}` : `${version}-dev`;

// Best-effort: a shallow/detached checkout (or no git at all) shouldn't fail
// the whole build over what's just an extra diagnostic field.
let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: APP_DIR, encoding: "utf8" }).trim();
} catch {
  /* left null */
}

const info = {
  tag,
  version,
  platform: suffix ? suffix.replace(/^-/, "") : null,
  buildNumber: n !== null ? Number(n) : null,
  commit,
  builtAt: new Date().toISOString(),
};

fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + "\n");
console.log(`wrote ${OUT}: ${tag}`);
