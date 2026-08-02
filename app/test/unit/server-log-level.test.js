"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isRoutineServerLine } = require("../../lib/server-log-level");

test("DEBUG and INFO lines (server.py's routine logging) are routine", () => {
  assert.equal(isRoutineServerLine("14:39:32 INFO cttc: transforms loaded from /some/path"), true);
  assert.equal(isRoutineServerLine("14:39:33 INFO cttc: GET /sources from 127.0.0.1 -> 200 (35 bytes, 3.6ms)"), true);
  assert.equal(isRoutineServerLine("09:00:00 DEBUG cttc: verbose detail"), true);
});

test("WARNING/ERROR/CRITICAL lines are not routine", () => {
  assert.equal(
    isRoutineServerLine(
      "13:03:42 WARNING cttc: redis_log: write queue full (Redis falling behind) -- dropping a sample for c3_api"
    ),
    false
  );
  assert.equal(isRoutineServerLine("13:03:42 ERROR cttc: something broke"), false);
  assert.equal(isRoutineServerLine("13:03:42 CRITICAL cttc: everything broke"), false);
});

test("lines that don't match the leveled format at all stay on the loud side", () => {
  assert.equal(isRoutineServerLine("Traceback (most recent call last):"), false);
  assert.equal(isRoutineServerLine('  File "server.py", line 42, in main'), false);
  assert.equal(isRoutineServerLine(""), false);
});

test("only matches at the start of the line, not merely containing INFO somewhere", () => {
  assert.equal(isRoutineServerLine("this INFO is not a leading timestamp"), false);
});
