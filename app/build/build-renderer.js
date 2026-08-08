#!/usr/bin/env node
// Bundles renderer/src/entry.ts (the new domain modules, extracted per
// docs/development/renderer-refactor-implementation-plan.md) into
// renderer/dist/modules.bundle.js -- a classic-script IIFE, deliberately
// NOT an ES module, so its top-level bindings can still be exposed as
// real `window` globals for the e2e harness (see that doc's "one fact
// that shapes everything else"). react/react-dom are aliased to Preact
// so Jotai's React-hook imports resolve without pulling in real React.
"use strict";
const esbuild = require("esbuild");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [path.join(ROOT, "renderer/src/entry.ts")],
  outfile: path.join(ROOT, "renderer/dist/modules.bundle.js"),
  bundle: true,
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "preact",
  alias: {
    react: "preact/compat",
    "react-dom": "preact/compat",
    "react/jsx-runtime": "preact/jsx-runtime",
  },
  sourcemap: true,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[build-renderer] watching for changes...");
  } else {
    await esbuild.build(options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
