// For state/functions renderer-spec.js reassigns directly by bare
// identifier (`loadSelectedTargets = async () => {...}`, `listContainers =
// () => {...}`, `dockerDaemonEditMode = true`) to stub them for a test.
//
// A plain `Object.assign(window, module)` copies each export's value once,
// at spread time -- fine for read-only access, but a snapshot: reassigning
// `window.x` afterward doesn't flow back into the module's own `let x`, so
// the module's own internal calls (which reference their local binding,
// not `window.x`) would never see the test's stub. This defines an
// accessor property instead, so `window.x = fn` really does reassign the
// module's own binding via the setter passed in here -- call this next to
// the `export let x = ...` declaration, in the module that owns it.
export function exposeMutable<T>(name: string, get: () => T, set: (v: T) => void): void {
  Object.defineProperty(window, name, { get, set, configurable: true });
}
