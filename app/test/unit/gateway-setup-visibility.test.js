"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldShowSkipButton } = require("../../lib/gateway-setup-visibility");

test("shown in new mode when Docker is detected", () => {
  assert.equal(shouldShowSkipButton({ mode: "new", dockerDetected: true }), true);
});

test("hidden in new mode when Docker is not detected (first launch or after a Hard Reset)", () => {
  assert.equal(shouldShowSkipButton({ mode: "new", dockerDetected: false }), false);
});

test("hidden in edit mode regardless of Docker detection", () => {
  assert.equal(shouldShowSkipButton({ mode: "edit", dockerDetected: true }), false);
  assert.equal(shouldShowSkipButton({ mode: "edit", dockerDetected: false }), false);
});

test("treats a missing/undefined dockerDetected as not detected", () => {
  assert.equal(shouldShowSkipButton({ mode: "new" }), false);
});
