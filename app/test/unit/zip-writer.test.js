"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildZip, crc32 } = require("../../lib/zip-writer");

function tmpZipPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cttc-zip-")), "out.zip");
}

// Round-trips through the real system `unzip` -- the actual correctness bar
// for a hand-rolled zip writer with no dependency to lean on is "every
// unzip tool everywhere can still open it", not just "my own code agrees
// with itself".
function extract(zipBuf) {
  const zipPath = tmpZipPath();
  fs.writeFileSync(zipPath, zipBuf);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cttc-unzip-"));
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", dir], { env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
  return dir;
}

test("crc32 matches a known vector", () => {
  eqHex(crc32(Buffer.from("123456789")), 0xcbf43926);
});
function eqHex(a, b) {
  assert.equal(a, b, `${a.toString(16)} !== ${b.toString(16)}`);
}

test("buildZip round-trips a single small text file", () => {
  const zip = buildZip([{ name: "hello.txt", data: Buffer.from("hello world\n") }]);
  const dir = extract(zip);
  assert.equal(fs.readFileSync(path.join(dir, "hello.txt"), "utf8"), "hello world\n");
});

test("buildZip round-trips multiple files with mixed compressibility", () => {
  const repetitive = Buffer.from("a".repeat(5000)); // compresses well -> DEFLATE
  const random = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))); // small/random -> likely STORE
  const zip = buildZip([
    { name: "a.log", data: repetitive },
    { name: "sub/b.log", data: random },
  ]);
  const dir = extract(zip);
  assert.ok(fs.readFileSync(path.join(dir, "a.log")).equals(repetitive));
  assert.ok(fs.readFileSync(path.join(dir, "sub", "b.log")).equals(random));
});

test("buildZip handles an empty file", () => {
  const zip = buildZip([{ name: "empty.log", data: Buffer.alloc(0) }]);
  const dir = extract(zip);
  assert.equal(fs.readFileSync(path.join(dir, "empty.log")).length, 0);
});

test("buildZip handles zero entries (a minimal, structurally valid EOCD-only archive)", () => {
  // unzip itself treats a 0-entry archive as an error condition (exit 1,
  // "zipfile is empty") even though it's spec-valid -- checking the raw
  // EOCD record directly sidesteps that rather than relying on the tool's
  // own opinion of what "valid" means here.
  const zip = buildZip([]);
  assert.equal(zip.length, 22); // EOCD record only, no local/central entries
  assert.equal(zip.readUInt32LE(0), 0x06054b50);
  assert.equal(zip.readUInt16LE(8), 0); // entry count
});

test("buildZip sets the UTF-8 filename flag for non-ASCII names", () => {
  // macOS's bundled unzip (old Info-ZIP, predates the UTF-8-flag
  // convention) mangles non-ASCII names regardless of the flag -- Python's
  // zipfile is UTF-8-aware and already a project dependency (server/), so
  // it's the more meaningful correctness check here.
  const zip = buildZip([{ name: "café.log", data: Buffer.from("x") }]);
  const zipPath = tmpZipPath();
  fs.writeFileSync(zipPath, zip);
  const listing = execFileSync("python3", [
    "-c",
    `import zipfile, sys; print(zipfile.ZipFile(sys.argv[1]).namelist())`,
    zipPath,
  ]).toString("utf8");
  assert.ok(listing.includes("café.log"), listing);
});
