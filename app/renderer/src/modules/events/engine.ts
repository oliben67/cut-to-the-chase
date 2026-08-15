import "../../shared/legacy-globals";
import { loadUiEvents, saveUiEvents } from "./dialogs";
import type { UiEvent, EventCondition } from "./types";

/* ── UI-hosted event engine: evaluates conditions against data this window
   already has (or a small targeted fetch), triggers via the same
   /files/download + /session/start primitives the manual features use,
   and saves the result locally via window.cttc.saveEventArtifact (silent
   -- no save dialog, since nobody's necessarily watching a background
   trigger). Metric conditions read the last non-null bucket already in
   state.series (the chart's own live-tailing data); log conditions poll
   /logs for the tail added since the last check, same cursor idea as the
   gateway's own events.py. */
const _OPS_JS: Record<string, (v: number, t: number) => boolean> = {
  ">": (v, t) => v > t, "<": (v, t) => v < t,
  ">=": (v, t) => v >= t, "<=": (v, t) => v <= t, "=": (v, t) => v === t,
};
function uiEventMonitoredIds(ev: UiEvent): string[] {
  return ev.sourceIds?.length ? ev.sourceIds : state.sources.map((s) => s.id);
}
export function checkUiMetricCondition(ev: UiEvent, cond: EventCondition): string | null {
  const ids = new Set(uiEventMonitoredIds(ev));
  const cmp = _OPS_JS[cond.op!];
  for (const svc of state.series?.services || []) {
    if (!ids.has(svc.sid)) continue;
    const arr = (svc[cond.metric!] as number[]) || [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] != null) return cmp(arr[i], cond.threshold!) ? `${svc.sid}/${svc.name}: ${cond.metric}=${arr[i]}` : null;
    }
  }
  return null;
}
// a log condition only watches lines appended after its cursor -- cursors
// are keyed per condition index (not just source id) so two log conditions
// on the same source in one event never share (and so corrupt) each
// other's read position, mirroring events.py's own per-condition cursors
async function checkUiLogCondition(ev: UiEvent, cond: EventCondition, condIndex: number): Promise<string | null> {
  const pattern = new RegExp(cond.pattern!);
  const cursors = (ev.logCursors[condIndex] ||= {});
  for (const sid of uiEventMonitoredIds(ev)) {
    const src = state.sources.find((s) => s.id === sid && s.kind === "log");
    if (!src) continue;
    const start = cursors[sid] || 0;
    try {
      const { total, rows } = await get(`/logs?source=${sid}&start=${start}&count=200`);
      cursors[sid] = total;
      for (const r of rows) if (pattern.test(r.text)) return `${sid}: matched ${JSON.stringify(r.text)}`;
    } catch { /* source may have closed since -- skip this tick */ }
  }
  return null;
}
// every condition is always evaluated (never short-circuited) so a log
// condition's cursor keeps advancing regardless of `match` or of an
// earlier condition already having fired -- mirrors events.py's _check()
export async function checkUiConditions(ev: UiEvent): Promise<string | null> {
  const details: Array<string | null> = [];
  for (let i = 0; i < ev.conditions.length; i++) {
    const cond = ev.conditions[i];
    details.push(cond.type === "metric" ? checkUiMetricCondition(ev, cond) : await checkUiLogCondition(ev, cond, i));
  }
  const hits = details.filter((d): d is string => d != null);
  if (ev.match === "all") return hits.length === ev.conditions.length ? hits.join("; ") : null;
  return hits[0] || null;
}

async function fireUiEvent(ev: UiEvent, detail: string): Promise<void> {
  ev.armed = false;
  ev.status = "triggered";
  ev.triggeredAt = Date.now();
  ev.triggerDetail = detail;
  ev.triggerCount = (ev.triggerCount || 0) + 1;
  notifyEvent(`Event "${ev.name}" fired (${detail})`);
  try {
    if (ev.action.kind === "snapshot") {
      const t1 = Date.now(), t0 = t1 - ev.action.minutes! * 60000;
      const params = new URLSearchParams({ from: String(t0), to: String(t1), include_host: "1" });
      const res = await fetch(`${API}/files/download?${params}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`snapshot failed: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const name = `${ev.name}-${ev.id}.cttc-metric`;
      const opts = { safe: ev.action.safe, maxKeepMs: ev.action.max_keep_seconds ? ev.action.max_keep_seconds * 1000 : null };
      ev.artifactPath = window.cttc?.saveEventArtifact ? await window.cttc.saveEventArtifact(name, bytes, opts) : null;
    } else {
      const { session_id } = await post("/legacy/session/start", {
        duration_minutes: ev.action.duration_minutes, safe: ev.action.safe, max_keep_seconds: ev.action.max_keep_seconds,
      });
      ev.artifactPath = session_id; // resolved to a real local path once the recording completes, see uiEventTick's poll
      ev._pendingGatewaySessionId = session_id;
    }
  } catch (err: unknown) {
    notifyEvent(`event "${ev.name}" trigger failed: ` + ((err as Error)?.message || err));
  }
  saveUiEvents(loadUiEvents().map((x) => (x.id === ev.id ? ev : x)));
}

// once a UI-hosted recording action's gateway session completes, fetch the
// bytes and replace the placeholder session id with a real local path
async function resolvePendingUiRecordings(): Promise<void> {
  const list = loadUiEvents();
  let changed = false;
  for (const ev of list) {
    if (!ev._pendingGatewaySessionId) continue;
    try {
      const st = await get(`/legacy/session/${ev._pendingGatewaySessionId}/status`);
      if (!st.ready) continue;
      const res = await fetch(`${API}/legacy/session/${ev._pendingGatewaySessionId}/download`, { headers: authHeaders() });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const name = `${ev.name}-${ev.id}.cttc-record`;
      const opts = { safe: ev.action.safe, maxKeepMs: ev.action.max_keep_seconds ? ev.action.max_keep_seconds * 1000 : null };
      ev.artifactPath = window.cttc?.saveEventArtifact ? await window.cttc.saveEventArtifact(name, bytes, opts) : null;
      delete ev._pendingGatewaySessionId;
      changed = true;
    } catch { /* not ready yet, or gateway unreachable this tick */ }
  }
  if (changed) saveUiEvents(list);
}

// gateway-hosted events trigger entirely server-side (see events.py's own
// tick()) -- this window only finds out by polling, so it has to remember
// each event's last-seen status itself to notice the armed -> triggered
// transition (and only notify once per transition, not every poll).
const gatewayEventLastStatus = new Map<string, string>();
async function pollGatewayEventTriggers(): Promise<void> {
  try {
    const { event_ids } = await get("/legacy/events/list");
    for (const id of event_ids) {
      const st = await get(`/legacy/events/${id}`);
      const last = gatewayEventLastStatus.get(id);
      if (st.status === "triggered" && last !== "triggered") {
        notifyEvent(`Event "${st.name}" fired (${st.trigger_detail || ""})`);
      }
      gatewayEventLastStatus.set(id, st.status);
    }
    for (const id of [...gatewayEventLastStatus.keys()]) {
      if (!event_ids.includes(id)) gatewayEventLastStatus.delete(id); // cancelled elsewhere
    }
  } catch { /* gateway may be unreachable this tick, or not support /events/* yet */ }
}

function isPopout(): boolean {
  return new URLSearchParams(location.search).get("popout") != null;
}

// An event keeps watching until disabled or deleted -- there's no one-shot
// "fires once and waits" state. To avoid re-firing (and re-snapshotting/
// re-recording) on every tick for as long as a condition happens to stay
// true, firing is edge-triggered via `ev.armed` (mirrors events.py's own
// `_armed` latch): only a not-met -> met transition fires; once met,
// `armed` goes false until the condition is seen not-met again.
export async function uiEventTick(): Promise<void> {
  if (isPopout()) return; // one evaluator per app instance is enough
  await resolvePendingUiRecordings();
  await pollGatewayEventTriggers();
  const list = loadUiEvents();
  for (const ev of list) {
    if (!ev.enabled) continue;
    const detail = await checkUiConditions(ev);
    if (detail) {
      if (ev.armed !== false) await fireUiEvent(ev, detail);
      ev.status = "triggered";
    } else {
      ev.armed = true;
      ev.status = "armed";
    }
  }
  saveUiEvents(list); // persists log cursor advances even without a trigger
}

// Called from mountEvents() (see index.ts), not at this module's own top
// level -- registering the interval itself is harmless either way (it only
// schedules, doesn't call uiEventTick immediately), but isPopout()'s
// equivalents elsewhere are called back in from app.js's boot for
// consistency, so this is too.
export function startUiEventLoop(): void {
  if (!isPopout()) setInterval(uiEventTick, 3000);
}
