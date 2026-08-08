# Feature Prompt: Buffered Collection Server + Rate-Bounded Polling Client

## Context

Implement a two-part system for a system-performance monitoring application:
a **collection server** that periodically captures logs and metrics into Redis,
and a **client** that polls the server's API to render those logs and metrics.
The Redis storage schema (key layout, data structures per metric/log record) is
**already defined** — treat it as a given and integrate with it; do not redesign it.

## Glossary

- **sRate** — *server rate*. Interval, in seconds, at which the server samples/flushes
  logs and metrics into Redis. **Default: `1` second.**
- **sTTL** — *server retention*. Number of days each record is retained in Redis before expiry.
  **Default: `3` days.**
- **cRate** — *client rate*. Interval, in seconds, at which the client polls the server API.
  **Default: equal to `sRate`** (so `1` second by default).

---

## Server Requirements

### 1. Buffered collection loop
- Run a background collector that buffers incoming logs and metrics and flushes them to
  Redis once every **sRate** seconds, using the already-defined structure.
- Each flushed record must carry (or be derivable to) a **creation timestamp**, because
  retention reconciliation (below) depends on knowing each record's age.
- Every record written is stored with an expiry derived from **sTTL** (see §3).

### 2. Runtime-adjustable sRate (no restart)
- **sRate must be changeable at runtime without restarting the process**, and this must
  hold whether the server runs containerized or as a plain process.
- The collector reads the *effective* sRate at the start of each cycle from a mutable
  source (e.g. an admin endpoint that updates shared state, a watched config value, or a
  dedicated Redis config key). Pick one mechanism and state it explicitly. The next cycle
  after a change must honor the new value — no redeploy, no signal-based restart.
- Changing sRate must **not** interrupt or drop the current in-memory buffer.

### 3. Retention (sTTL) — restart-scoped
- **sTTL is read only at startup** and cannot change while the server runs. Changing
  retention requires a server restart. Do not expose a runtime mutator for it.
- The active sTTL is applied as the expiry on every record written during the run.

### 4. Startup retention reconciliation (atomic, via Lua)
On startup, before (or as) the collector begins:
- Persist the currently applied retention as metadata (e.g. a Redis key such as
  `config:sTTL`). On boot, compare the newly configured sTTL against this stored value.
- **If sTTL is unchanged**, do nothing.
- **If sTTL changed**, re-apply retention to **all existing records** so their expiry
  reflects the new policy. This MUST run inside a **single Lua script (EVAL)** so the
  entire update happens in one Redis execution context.
- Reconciliation is **age-based, not a blanket reset**. For each record, compute:
  `new_expiry_remaining = (creation_timestamp + newTTL) - now`
    - if `> 0` → set the record's TTL to that remaining lifetime;
    - if `<= 0` → the record is already past the new retention → delete it.
  Do **not** simply stamp `newTTL` onto every key, as that would incorrectly extend the
  lifetime of already-old data.
- After a successful reconciliation, update the stored sTTL metadata to the new value.

**Decision point to resolve in implementation:** a single Lua script iterating the entire
keyspace is atomic but blocks Redis for the duration. State how you handle scale — e.g.
keep it as one atomic script (honoring strict same-context semantics) and document the
blocking window, or switch to SCAN-based batched scripts (relaxing atomicity). Default to
the single atomic script unless the expected keyspace makes blocking unacceptable.

---

## Client Requirements

### 1. Polling
- Query the server's API every **cRate** seconds and present the returned data as
  **graphs** (metrics) and **logs**.

### 2. Rate constraint: cRate ≥ sRate
- The client's poll interval **must never be shorter than the server's sRate** — polling
  faster than the server samples yields no new data and wastes cycles.
- Because sRate can change at runtime, the client must **know the current sRate** (fetch it
  from the server / an exposed endpoint) and **continuously re-validate** the constraint.
- If a configured cRate is below the current sRate: **clamp cRate up to sRate and surface a
  warning** to the user (rather than silently accepting an invalid rate or hard-failing).
  If sRate later rises above the active cRate at runtime, adjust cRate up accordingly.

---

## Cross-Cutting Notes

- Integrate with the **existing Redis schema**; do not invent a new one.
- Make sRate, sTTL, and cRate configurable via clearly named settings/env vars, with
  defaults: `sRate=1` (second), `sTTL=3` (days), `cRate=sRate`.
- Log the effective values of sRate (on each change), sTTL (at startup, plus whether
  reconciliation ran and how many records were updated/deleted), and cRate (on each clamp).
- Behavior must be identical containerized vs. non-containerized.

## Deliverables

- Server: buffered collector, runtime sRate reload, startup retention reconciliation Lua script.
- Client: rate-bounded poller with graph + log rendering.
- The Lua reconciliation script, isolated and testable.
- Brief notes on: the sRate reload mechanism chosen, and the atomic-vs-batched Lua decision.