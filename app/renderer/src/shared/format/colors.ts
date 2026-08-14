/* ── categorical colors: fixed slot order, never cycled ─────────────────── */

const slotByName = new Map<string, number>();
// The first 8 concurrent series get one of the theme's curated --series-N
// colors, assigned the first time a given series name is seen and never
// reassigned afterward (see assignColorSlots(), which seeds this map in a
// stable sort order so colors don't shuffle around as sources come and
// go). Past 8, every *additional* container still gets its own genuinely
// distinct, full-saturation color -- procedurally generated (golden-angle
// hue rotation, so consecutive slots are always maximally far apart in hue
// and never visually repeat, no matter how many containers there are) --
// rather than folding to --muted gray. Gray is reserved for containers that
// are actually disabled/not-selected (see legendItem's own "disabled"
// class) -- a live, selected container must never read as "disabled" just
// because it happened to be the 9th one.
const GENERATED_COLOR_SAT = 68;

// Reserve this name's slot if it doesn't have one yet -- the only piece of
// slotByName's bookkeeping app.js's own assignColorSlots() needs from
// outside this module (it decides *which* names to reserve slots for from
// state.series/state.sources, which live outside FMT's scope).
export function ensureColorSlot(name: string): void {
  if (!slotByName.has(name)) slotByName.set(name, slotByName.size);
}

export function generatedSlotColor(slot: number): string {
  const hue = (slot * 137.508) % 360; // golden angle -- maximally spread hues, never repeats
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const lightness = dark ? 62 : 42; // brighter on a dark background, darker on a light one -- same idea as the curated --series-N pairs
  return `hsl(${hue.toFixed(1)}, ${GENERATED_COLOR_SAT}%, ${lightness}%)`;
}

export function colorFor(name: string): string {
  if (!slotByName.has(name)) slotByName.set(name, slotByName.size);
  const slot = slotByName.get(name)!;
  if (slot >= 8) return generatedSlotColor(slot);
  const css = getComputedStyle(document.documentElement);
  return css.getPropertyValue(`--series-${slot + 1}`).trim();
}

// Read a CSS custom property (e.g. "--accent") off :root -- the single
// source of truth for every color used in canvas drawing, so charts follow
// the active light/dark theme automatically without their own duplicated
// palette.
export function themeVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ── sample vs. live styling ───────────────────────────────────────────────
   ui-CHART-026 (see stay-the-course/sampled-vs-live-data.md, updated):
   a loaded .cttc-metric/.cttc-record sample's data is exactly as real as
   live data, just not still updating -- the main charts (lines/bars) draw
   it identically to live data, full color/saturation, no dashing. Log
   density lanes (a different, auxiliary chart element -- see
   ui-CHART-009) still hatch sample-sourced lanes; each *sample file*
   (source id) still gets its own gray level there so several loaded
   samples stay visually distinguishable from each other. */

const sampleSlotBySid = new Map<string, number>();

export function sampleSlot(sid: string): number {
  if (!sampleSlotBySid.has(sid)) sampleSlotBySid.set(sid, sampleSlotBySid.size);
  return sampleSlotBySid.get(sid)!;
}

const SAMPLE_GRAY_LEVELS = [0.3, 0.45, 0.6, 0.75];

// "#rrggbb" -> [r, g, b] ints, or null if the string doesn't match (theme
// colors always do; this is just defensive against a malformed CSS value).
export function hexToRgb(hex: string | null | undefined): [number, number, number] | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex || "").trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

// blend a series color toward neutral gray by this sample's own gray level
export function grayedColor(hex: string, sid: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const frac = SAMPLE_GRAY_LEVELS[sampleSlot(sid) % SAMPLE_GRAY_LEVELS.length];
  const [r, g, b] = rgb.map((c) => Math.round(c + (136 - c) * frac));
  return `rgb(${r}, ${g}, ${b})`;
}

// diagonal hatch fill pattern, one per (color, sample) pair — used for
// histogram bars and density lanes belonging to a loaded sample
const hatchPatternCache = new Map<string, CanvasPattern | null>();

export function hatchPattern(ctx: CanvasRenderingContext2D, color: string, sid: string): CanvasPattern | null {
  const key = color + "|" + sid;
  let pattern = hatchPatternCache.get(key);
  if (pattern) return pattern;
  const size = 6;
  const pc = document.createElement("canvas");
  pc.width = pc.height = size;
  const pctx = pc.getContext("2d")!;
  pctx.strokeStyle = color;
  pctx.lineWidth = 1;
  pctx.beginPath();
  pctx.moveTo(0, size);
  pctx.lineTo(size, 0);
  pctx.stroke();
  pattern = ctx.createPattern(pc, "repeat");
  hatchPatternCache.set(key, pattern);
  return pattern;
}
