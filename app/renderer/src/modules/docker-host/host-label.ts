// Human-readable label for a docker-host key -- "local" becomes
// "localhost", anything else has its "ssh://" scheme stripped. Collapses
// what used to be four verbatim copies of the same expression across
// state.ts, remove-dialog.ts, and pill.ts (twice).
export function dockerHostLabel(hostKey: string): string {
  return hostKey === "local" ? "localhost" : hostKey.replace(/^ssh:\/\//, "");
}
