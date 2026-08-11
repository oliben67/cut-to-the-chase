"use strict";

const { execFile } = require("child_process");

// br-AUDIT-003 (REQ-0071): TCP-connect liveness check against the
// gateway's own service port (never 22) -- a plain L4 probe, not an
// actual SSH handshake, despite the source spec calling this "ssh-ping".
// Named tcpPing here instead to avoid that confusion in code/logs (see
// REQ-0071's "Vetted against existing rules"). Shells to real OS tooling
// per the story's own acceptance criteria, rather than Node's net.connect
// (already used by net-wait.js's waitForPortOpen) -- matches
// ssh-tunnel.js's existing pattern of shelling to OS tools elsewhere in
// this file set.
function tcpPing(host, port, { timeoutMs = 3000 } = {}) {
  const timeoutSecs = Math.max(1, Math.ceil(timeoutMs / 1000));
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Test-NetConnection -ComputerName '${host}' -Port ${port} -InformationLevel Quiet -WarningAction SilentlyContinue)`,
        ],
        { timeout: timeoutMs },
        (err, stdout) => {
          if (!err) {
            resolve(String(stdout).trim().toLowerCase() === "true");
            return;
          }
          // Test-NetConnection missing/failed outright -- telnet is the
          // documented fallback, not the primary (br-AUDIT-003): it has
          // no clean "port open" exit code of its own, so a zero exit is
          // the best available signal.
          execFile("telnet", [host, String(port)], { timeout: timeoutMs }, (err2) => resolve(!err2));
        }
      );
      return;
    }
    execFile("nc", ["-z", "-w", String(timeoutSecs), host, String(port)], { timeout: timeoutMs }, (err) =>
      resolve(!err)
    );
  });
}

// br-AUDIT-001/002: single-shot fetch with its own timeout against the
// unauthenticated GET /ping (REQ-0070/br-MESH-006) -- unlike net-wait.js's
// waitForHttpOk, this never retries: the audit needs exactly one answer
// per entry per pass, not "keep trying until this gateway comes up"
// (that's provisioning's job). Hits /ping specifically (not /health) so
// this works even for a newly-discovered peer the caller has no
// X-CTTC-Token for yet.
async function httpPing(host, port, { timeoutMs = 3000, fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(`http://${host}:${port}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

// br-AUDIT-002: the fixed interpretation truth table. HTTP ok always wins
// regardless of the TCP result. HTTP fail + TCP open means *some* service
// answered but isn't confirmed to be this gateway. HTTP fail + TCP
// closed/timeout means genuinely nothing answered -- asserted as the
// confident negative "absent" only if this entry was ever actually
// confirmed present (or already absent) before; an entry that was only
// ever "unknown" stays "unknown" rather than jumping straight to a
// negative claim about something never actually confirmed either way.
function interpretAuditResult(httpOk, tcpOpen, previousExistence) {
  const lastContactAt = new Date().toISOString();
  if (httpOk) {
    return { existence: "existing", lastContactResult: "ok", lastContactAt };
  }
  if (tcpOpen) {
    return { existence: "unknown", lastContactResult: "failed", lastContactAt };
  }
  const wasVerified = previousExistence === "existing" || previousExistence === "absent";
  return { existence: wasVerified ? "absent" : "unknown", lastContactResult: "failed", lastContactAt };
}

// One entry, both probes, run independently and concurrently with each
// other (br-AUDIT-001). httpPingFn/tcpPingFn are only ever overridden by
// tests -- real callers always get the real httpPing/tcpPing above.
async function auditGateway(entry, { timeoutMs = 3000, onLog, fetchFn, httpPingFn = httpPing, tcpPingFn = tcpPing } = {}) {
  const [httpOk, tcpOpen] = await Promise.all([
    httpPingFn(entry.host, entry.port, { timeoutMs, fetchFn }),
    tcpPingFn(entry.host, entry.port, { timeoutMs }),
  ]);
  const result = interpretAuditResult(httpOk, tcpOpen, entry.existence);
  onLog?.(`[audit] ${entry.host}:${entry.port} -> ${result.existence} (${result.lastContactResult})`);
  return { ...entry, ...result };
}

// br-AUDIT-001/005: audits every entry independently, capped at
// `concurrency` in-flight entries at a time via a simple worker pool
// pulling from a shared index -- no new dependency (no p-limit et al).
// Each worker moves on to its next entry as soon as its current one
// settles, so one slow/hung entry only ever blocks the single worker
// that picked it up, never the others or the batch as a whole. The outer
// per-entry race is a belt-and-braces bound on top of httpPing/tcpPing's
// own internal timeouts -- real callers should never need it (both real
// probes already resolve within timeoutMs on their own), but it keeps a
// misbehaving injected probe (or a genuine bug) from wedging the whole
// pool forever rather than just failing that one entry.
async function auditGatewayList(entries, { concurrency = 8, timeoutMs = 3000, onLog, fetchFn, httpPingFn, tcpPingFn } = {}) {
  const results = new Array(entries.length);
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const i = next++;
      const entry = entries[i];
      results[i] = await Promise.race([
        auditGateway(entry, { timeoutMs, onLog, fetchFn, httpPingFn, tcpPingFn }),
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ ...entry, existence: "unknown", lastContactResult: "failed", lastContactAt: new Date().toISOString() }),
            timeoutMs + 200
          ).unref?.()
        ),
      ]);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = { tcpPing, httpPing, interpretAuditResult, auditGateway, auditGatewayList };
