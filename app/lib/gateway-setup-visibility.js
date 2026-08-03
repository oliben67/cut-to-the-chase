"use strict";

// Pulled out of gateway-setup.js (a standalone first-run wizard window the
// e2e renderer-spec.js test harness never loads -- it only loads index.html)
// so this one decision is actually unit-testable.
//
// "Skip -- use this machine" only makes sense in the "new" first-run/
// no-local-docker fallback flow (never in "edit" mode, see gateway-setup.js),
// and only when Docker is actually present locally to fall back to --
// without it, Skip would silently drop into the bare/no-Docker embedded
// path, not what its own "use this machine's own Docker (or none)" label
// promises. main.js probes this fresh (hasLocalDocker()) every time this
// window opens -- first launch, or a later launch after a Hard Reset --
// there's no persisted "first run" flag to go stale.
function shouldShowSkipButton({ mode, dockerDetected }) {
  return mode !== "edit" && !!dockerDetected;
}

module.exports = { shouldShowSkipButton };
