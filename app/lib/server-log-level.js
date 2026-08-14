"use strict";

// server.py's logging.basicConfig (see server.py's main()) formats every
// line as "HH:MM:SS LEVELNAME name: message" and sends *every* level to
// stderr, not just actual errors (that's deliberate on the Python side --
// one stream, one format, easy to tail). main.js used to treat 100% of that
// stream as an error-level main-log entry, so every routine per-request
// INFO line showed up in DevTools as a red "exception" alongside any real
// warning/error, burying the signal in noise (br-LOG-001). This is the
// classification main.js's stderr handler uses to tell them apart --
// pulled out into its own module (matching lib/*.js's existing pattern)
// since main.js itself can't be unit-tested outside a real Electron
// runtime (requiring "electron" outside one doesn't give the real API).
const ROUTINE_LEVEL = /^\d{2}:\d{2}:\d{2}\s+(?:DEBUG|INFO)\b/;

// True for a DEBUG/INFO line from server.py's own formatter -- false for
// WARNING/ERROR/CRITICAL, and false for anything that doesn't match the
// format at all (a raw Python traceback, an unformatted print, ...), which
// deliberately stays on the loud/error side rather than being silently
// downgraded.
function isRoutineServerLine(line) {
  return ROUTINE_LEVEL.test(line);
}

module.exports = { isRoutineServerLine };
