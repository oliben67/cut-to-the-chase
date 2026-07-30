"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readSettings, writeSettings, logFileName } = require("../../lib/log-collector");

function tmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cttc-logcol-")), "log-collector.json");
}

test("readSettings returns {enabled:false, dir:null} when the file doesn't exist yet", () => {
  assert.deepEqual(readSettings({ configPath: tmpPath() }), { enabled: false, dir: null });
});

test("readSettings returns the off default on corrupt JSON rather than throwing", () => {
  const p = tmpPath();
  fs.writeFileSync(p, "{ not json");
  assert.deepEqual(readSettings({ configPath: p }), { enabled: false, dir: null });
});

test("writeSettings then readSettings round-trips", () => {
  const p = tmpPath();
  writeSettings({ enabled: true, dir: "/tmp/cttc-logs" }, { configPath: p });
  assert.deepEqual(readSettings({ configPath: p }), { enabled: true, dir: "/tmp/cttc-logs" });
});

test("readSettings tolerates a leading UTF-8 BOM", () => {
  const p = tmpPath();
  fs.writeFileSync(p, "﻿" + JSON.stringify({ enabled: true, dir: "/x" }));
  assert.deepEqual(readSettings({ configPath: p }), { enabled: true, dir: "/x" });
});

test("logFileName uses the .cttc-log extension and a colon/dot-free timestamp", () => {
  const name = logFileName(new Date("2026-07-25T14:20:00.123Z"));
  assert.equal(name, "2026-07-25T14-20-00-123Z.cttc-log");
  assert.ok(!name.includes(":"), "no raw colons -- invalid in Windows filenames");
});
