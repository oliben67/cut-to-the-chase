// bytes/sec -> the largest unit (GB/MB/kB/B) that keeps the number >= 1,
// one decimal place -- used for the NET strip's axis labels and tooltip.
export function fmtBytes(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + " GB/s";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + " MB/s";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + " kB/s";
  return v.toFixed(0) + " B/s";
}

// HH:MM:SS[.mmm] -- deliberately no date component. Every timestamp shown
// in this app is recent enough (the same recording/live session) that the
// date would just be visual noise in practice, and the full ISO timestamp
// is still available via title/fmtIso() wherever precision actually matters
// (log row tooltips, snapshots).
export function fmtClock(ms: number, withMs?: boolean): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  let s = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  if (withMs) s += "." + p(d.getMilliseconds(), 3);
  return s;
}

// Server-side transform ids (see server/transforms/*.py) as they should
// read anywhere in the UI -- the bare snake_case id (json_message,
// parse_level) must never be displayed literally. "JSON" is a proper
// acronym (special-cased); everything else just loses its underscores.
export function formatTransformName(name: string): string {
  if (name === "json_message") return "JSON message";
  return name.replace(/_/g, " ");
}
