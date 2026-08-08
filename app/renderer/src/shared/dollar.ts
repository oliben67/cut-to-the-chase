// A real, independent implementation -- not app.js's `$`, which doesn't
// exist yet at this bundle's own module-load time (see legacy-globals.ts).
// Untyped on purpose, matching app.js's own usage of its own `$` (never
// null-checked, never distinguishes HTMLInputElement/HTMLSelectElement/
// etc.) -- this is a faithful port of existing imperative DOM code, not a
// rewrite.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function $(id: string): any {
  return document.getElementById(id);
}
