import "../../shared/legacy-globals";
import { $ } from "../../shared/dollar";
import type { UiEvent, GatewayEvent } from "./types";

// Untyped on purpose, matching $'s own pragmatic looseness -- a faithful
// port of existing imperative DOM code (never null-checked, condition rows
// are always freshly built from the innerHTML template just above each use)
// rather than a rewrite.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function q(el: Element, selector: string): any {
  return el.querySelector(selector);
}

/* ── Events: watch CPU/MEM/NET thresholds or a log regex on chosen systems,
   snapshot or record automatically when the condition is met ────────────
   "Gateway"-hosted events are registered on the server (server/events.py)
   and keep watching even if this window closes; "this app"-hosted events
   are evaluated right here against data the renderer already has (or a
   small targeted fetch for it), and only watch while this window is open.
   Either way, triggering reuses the same primitives the manual Capture
   Metrics/Record features already use (GET /files/download, POST
   /session/start) -- an event is just an automatic way to call them. */

const UI_EVENTS_KEY = "uiEvents";
export function loadUiEvents(): UiEvent[] {
  return prefs.get(UI_EVENTS_KEY, []) as UiEvent[];
}
export function saveUiEvents(list: UiEvent[]): void {
  prefs.set(UI_EVENTS_KEY, list);
}

export const dlgEventForm = $("dlg-event-form");
export const dlgEventList = $("dlg-event-list");

// null while creating a brand-new event; {id, hosted} while dlg-event-form
// is instead editing an existing one (see openEventEditForm) -- the same
// form and the same submit button (#dlg-event-create) serve both, since an
// edit is just a create() whose fields start pre-filled and whose submit
// calls update() instead.
export let editingEvent: { id: string; hosted: string } | null = null;

function resetEventForm(): void {
  renderEventSystemsPicker();
  $("event-name").value = "";
  $("event-hosted").value = "gateway";
  $("event-hosted").disabled = false;
  $("event-conditions").innerHTML = "";
  addEventConditionRow();
  syncEventMatchRowVisibility();
  $("event-action-kind").value = "snapshot";
  $("event-action-minutes").value = "5";
  $("event-action-duration").value = "10";
  $("event-safe").checked = false;
  $("event-max-keep").value = "86400";
  syncEventActionFields();
  $("event-max-keep-row").hidden = true;
}

export function openEventCreateDialog(): void {
  editingEvent = null;
  resetEventForm();
  $("event-form-title").textContent = "Create Event";
  $("dlg-event-create").textContent = "Create event";
  dlgEventForm.showModal();
}
$("btn-event-create").onclick = openEventCreateDialog;
$("dlg-event-form-cancel").onclick = () => dlgEventForm.close();

// Edit Events > Update on a row: same form, pre-filled from the event's
// current fields; `hosted` can't be changed here (moving an event from
// local to gateway or back isn't supported -- create a new one instead).
export function openEventEditForm(ev: GatewayEvent | UiEvent, hosted: string): void {
  editingEvent = { id: hosted === "gateway" ? ev.event_id : ev.id, hosted };
  resetEventForm();
  $("event-name").value = ev.name;
  $("event-hosted").value = hosted;
  $("event-hosted").disabled = true;
  const sourceIds = new Set(hosted === "gateway" ? ev.source_ids : ev.sourceIds);
  for (const cb of document.querySelectorAll("[data-event-system]")) (cb as HTMLInputElement).checked = sourceIds.has((cb as HTMLInputElement).value);

  $("event-conditions").innerHTML = "";
  for (const cond of ev.conditions) {
    addEventConditionRow();
    const row = $("event-conditions").lastElementChild;
    row.querySelector('[data-field="type"]').value = cond.type;
    row.querySelector('[data-field="type"]').dispatchEvent(new Event("change"));
    if (cond.type === "metric") {
      row.querySelector('[data-field="metric"]').value = cond.metric;
      row.querySelector('[data-field="op"]').value = cond.op;
      row.querySelector('[data-field="threshold"]').value = cond.threshold;
    } else {
      row.querySelector('[data-field="pattern"]').value = cond.pattern;
    }
  }
  syncEventMatchRowVisibility();
  $("event-match").value = ev.match;

  $("event-action-kind").value = ev.action.kind;
  syncEventActionFields();
  $("event-action-minutes").value = ev.action.minutes || 5;
  $("event-action-duration").value = ev.action.duration_minutes || 10;
  $("event-safe").checked = !!ev.action.safe;
  $("event-max-keep-row").hidden = !ev.action.safe;
  $("event-max-keep").value = ev.action.max_keep_seconds || 86400;

  $("event-form-title").textContent = "Edit Event";
  $("dlg-event-create").textContent = "Save changes";
  dlgEventList.close();
  dlgEventForm.showModal();
}

export async function openEventListDialog(): Promise<void> {
  await refreshEventsList();
  dlgEventList.showModal();
}
$("btn-event-edit").onclick = openEventListDialog;
$("dlg-event-list-close").onclick = () => dlgEventList.close();

function renderEventSystemsPicker(): void {
  const box = $("event-systems");
  box.innerHTML = "";
  for (const s of state.sources) {
    const label = document.createElement("label");
    label.className = "ctl block";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = s.id;
    cb.dataset.eventSystem = "1";
    label.appendChild(cb);
    label.append(` ${s.name} (${s.kind})`);
    box.appendChild(label);
  }
  if (!state.sources.length) box.textContent = "No open sources yet -- events will monitor everything once sources exist.";
}
function selectedEventSystems(): string[] {
  return [...document.querySelectorAll("[data-event-system]:checked")].map((cb) => (cb as HTMLInputElement).value);
}

// an event can carry more than one condition (see events.py's `match`) --
// each row here is one condition (metric threshold or log regex), added/
// removed freely; "Trigger when" (any/all) only matters -- and so is only
// shown -- once there's more than one row.
function addEventConditionRow(): void {
  const box = $("event-conditions");
  const row = document.createElement("div");
  row.className = "keys-box";
  row.dataset.conditionRow = "1";
  row.innerHTML = `
    <label class="ctl">Condition
      <select data-field="type">
        <option value="metric">Metric threshold</option>
        <option value="log">Log regular expression</option>
      </select>
    </label>
    <span data-fields="metric">
      <label class="ctl">Metric
        <select data-field="metric">
          <option value="cpu">CPU %</option>
          <option value="mem">MEM %</option>
          <option value="net">NET B/s</option>
        </select>
      </label>
      <label class="ctl">Op
        <select data-field="op">
          <option value=">">&gt;</option>
          <option value="<">&lt;</option>
          <option value=">=">&gt;=</option>
          <option value="<=">&lt;=</option>
          <option value="=">=</option>
        </select>
      </label>
      <label class="ctl">Threshold <input data-field="threshold" type="number" step="any" value="80" /></label>
    </span>
    <span data-fields="log" hidden>
      <label class="ctl block">Regex <input data-field="pattern" type="text" placeholder="e.g. ERROR|FATAL" /></label>
    </span>
    <button type="button" data-remove-condition>Remove</button>
  `;
  q(row, '[data-field="type"]').onchange = (e: Event) => {
    const isMetric = (e.target as HTMLSelectElement).value === "metric";
    q(row, '[data-fields="metric"]').hidden = !isMetric;
    q(row, '[data-fields="log"]').hidden = isMetric;
  };
  q(row, "[data-remove-condition]").onclick = () => {
    row.remove();
    syncEventMatchRowVisibility();
  };
  box.appendChild(row);
  syncEventMatchRowVisibility();
}
$("event-add-condition").onclick = addEventConditionRow;
function syncEventMatchRowVisibility(): void {
  $("event-match-row").hidden = $("event-conditions").children.length < 2;
}

function syncEventActionFields(): void {
  const isSnapshot = $("event-action-kind").value === "snapshot";
  $("event-action-minutes-row").hidden = !isSnapshot;
  $("event-action-duration-row").hidden = isSnapshot;
}
$("event-action-kind").onchange = syncEventActionFields;
$("event-safe").onchange = (e: Event) => { $("event-max-keep-row").hidden = !(e.target as HTMLInputElement).checked; };

export function buildEventConditions() {
  return [...document.querySelectorAll("[data-condition-row]")].map((row) => {
    const type = q(row, '[data-field="type"]').value;
    if (type === "metric") {
      return {
        type: "metric",
        metric: q(row, '[data-field="metric"]').value,
        op: q(row, '[data-field="op"]').value,
        threshold: Number(q(row, '[data-field="threshold"]').value),
      };
    }
    return { type: "log", pattern: q(row, '[data-field="pattern"]').value };
  });
}
export function buildEventAction() {
  const kind = $("event-action-kind").value;
  return {
    kind,
    minutes: kind === "snapshot" ? Number($("event-action-minutes").value) : null,
    duration_minutes: kind === "recording" ? Number($("event-action-duration").value) : null,
    safe: $("event-safe").checked,
    max_keep_seconds: $("event-safe").checked ? Number($("event-max-keep").value) : null,
  };
}

$("dlg-event-create").onclick = async () => {
  const name = $("event-name").value.trim() || "unnamed event";
  const sourceIds = selectedEventSystems();
  const conditions = buildEventConditions();
  const action = buildEventAction();
  const match = $("event-match").value;
  if (!conditions.length) { notifyEvent("add at least one condition"); return; }
  // Gateway-hosted conditions are validated server-side (events.py's
  // _validate: a bad regex or a NaN-turned-null threshold both 400 there) --
  // UI-hosted ones have no server to reject them, so an invalid value would
  // otherwise be stored to localStorage as-is: a NaN/blank threshold
  // silently breaks every future comparison (ui-EVT-003), and an invalid
  // regex throws uncaught from uiEventTick's setInterval callback on every
  // tick, which (since that throw aborts the loop before saveUiEvents runs)
  // silently stops evaluating and persisting cursor progress for every OTHER
  // UI-hosted event too, not just this one (ui-EVT-004).
  //
  // Validated against the raw field values, not `conditions` (already built
  // via Number(...)/read as-is above): a `type="number"` input silently
  // sanitizes anything it can't parse (empty included) down to "" rather
  // than leaving it as typed, and Number("") is 0 -- a legitimate threshold,
  // not something Number.isFinite would ever catch -- so "was this field
  // actually left blank/unparseable" can only be answered from its raw
  // string, before that coercion already happened.
  const isUiHosted = editingEvent ? editingEvent.hosted !== "gateway" : $("event-hosted").value !== "gateway";
  if (isUiHosted) {
    for (const row of document.querySelectorAll("[data-condition-row]")) {
      const type = q(row, '[data-field="type"]').value;
      if (type === "metric") {
        const raw = q(row, '[data-field="threshold"]').value;
        if (raw.trim() === "" || !Number.isFinite(Number(raw))) {
          notifyEvent("threshold must be a valid number");
          return;
        }
      } else {
        const pattern = q(row, '[data-field="pattern"]').value;
        try {
          new RegExp(pattern);
        } catch {
          notifyEvent(`invalid regex: ${pattern}`);
          return;
        }
      }
    }
  }
  try {
    if (editingEvent) {
      const { id, hosted } = editingEvent;
      if (hosted === "gateway") {
        await post(`/events/${id}/update`, { name, source_ids: sourceIds, conditions, match, action });
      } else {
        const list = loadUiEvents();
        const ev = list.find((x) => x.id === id);
        if (ev) Object.assign(ev, { name, sourceIds, conditions, match, action });
        saveUiEvents(list);
      }
      notifyEvent(`Event "${name}" updated`);
    } else if ($("event-hosted").value === "gateway") {
      await post("/events/create", { name, source_ids: sourceIds, conditions, match, action });
      notifyEvent(`Event "${name}" created`);
    } else {
      const list = loadUiEvents();
      list.push({
        id: `ui${Date.now()}`,
        name, sourceIds, conditions, match, action,
        enabled: true, status: "armed", armed: true,
        triggeredAt: null, triggerDetail: null, artifactPath: null,
        logCursors: {}, // {conditionIndex: {sourceId: rowsScanned}}
      } as UiEvent);
      saveUiEvents(list);
      notifyEvent(`Event "${name}" created`);
    }
    dlgEventForm.close();
  } catch (err: unknown) {
    notifyEvent(`could not ${editingEvent ? "update" : "create"} event: ` + ((err as Error)?.message || err));
  }
};

// one row per event, gateway- and UI-hosted alike, each with its own
// enable/disable, reset (re-arm after a trigger), and delete/cancel
function renderEventRow(ev: GatewayEvent | UiEvent, hosted: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "ctl block";
  const condText = (c: { type: string; metric?: string; op?: string; threshold?: number; pattern?: string }) =>
    c.type === "metric" ? `${c.metric} ${c.op} ${c.threshold}` : `log ~ /${c.pattern}/`;
  const conditions = (ev.conditions || []).map(condText).join(ev.match === "all" ? " AND " : " OR ");
  const act = ev.action.kind === "snapshot" ? `snapshot (last ${ev.action.minutes}m)` : `record ${ev.action.duration_minutes}m`;
  row.textContent = `[${hosted}] ${ev.name} -- ${conditions} -> ${act} -- ${ev.status}${ev.status === "triggered" ? ` (${ev.trigger_detail || ev.triggerDetail || ""})` : ""} `;

  const mkBtn = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.type = "button";
    b.onclick = fn;
    return b;
  };
  const id = hosted === "gateway" ? ev.event_id : ev.id;
  row.appendChild(mkBtn("Update", () => openEventEditForm(ev, hosted)));
  row.appendChild(mkBtn(ev.enabled ? "Disable" : "Enable", async () => {
    if (hosted === "gateway") await post(`/events/${id}/${ev.enabled ? "disable" : "enable"}`, {});
    else { const list = loadUiEvents(); const e = list.find((x) => x.id === id)!; e.enabled = !e.enabled; saveUiEvents(list); }
    refreshEventsList();
  }));
  if (ev.status === "triggered") {
    row.appendChild(mkBtn("Reset", async () => {
      if (hosted === "gateway") await post(`/events/${id}/reset`, {});
      else { const list = loadUiEvents(); const e = list.find((x) => x.id === id)!; e.armed = true; e.status = "armed"; saveUiEvents(list); }
      refreshEventsList();
    }));
    const artifactId = hosted === "gateway" ? ev.artifact_id : ev.artifactPath;
    if (artifactId) {
      row.appendChild(mkBtn("Save…", async () => {
        try {
          if (hosted === "gateway") {
            const res = await fetch(`${API}/session/${artifactId}/download`, { headers: authHeaders() });
            if (!res.ok) throw new Error(`download failed: ${res.status}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            const ext = res.headers.get("Content-Disposition")?.includes(".cttc-record") ? ".cttc-record" : ".cttc-metric";
            await saveBinaryFile(`${ev.name}-${id}${ext}`, bytes);
          } else if (window.cttc?.readFile) {
            const bytes = await window.cttc.readFile(artifactId);
            await saveBinaryFile(artifactId.split("/").pop(), bytes);
          }
        } catch (err: unknown) {
          notifyEvent("could not save event artifact: " + ((err as Error)?.message || err));
        }
      }));
    }
  }
  row.appendChild(mkBtn(hosted === "gateway" ? "Cancel" : "Delete", async () => {
    if (hosted === "gateway") await post(`/events/${id}/cancel`, {});
    else saveUiEvents(loadUiEvents().filter((x) => x.id !== id));
    refreshEventsList();
  }));
  return row;
}

export async function refreshEventsList(): Promise<void> {
  const box = $("events-list");
  box.innerHTML = "";
  try {
    const { event_ids } = await get("/events/list");
    for (const id of event_ids) {
      const ev = await get(`/events/${id}`);
      box.appendChild(renderEventRow(ev, "gateway"));
    }
  } catch {
    /* gateway may not support /events (older server) -- UI events still work */
  }
  for (const ev of loadUiEvents()) box.appendChild(renderEventRow(ev, "ui"));
  if (!box.children.length) box.textContent = "No events yet.";
}
