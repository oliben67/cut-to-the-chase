import type { StatusBarHistoryEntry } from "./status-bar.state";

// Plain prop-driven component, no atom subscription (see status-bar.state's
// comment on statusBarHistory) -- rendered explicitly, synchronously, by
// status-bar.actions whenever the underlying array changes. Replaces the
// existing #status-bar-history-list div in place (see mount()). Newest
// first, same as the original renderStatusBarHistory().
export function HistoryList({ history }: { history: StatusBarHistoryEntry[] }) {
  return (
    <div id="status-bar-history-list" class="activity-log status-bar-history-list">
      {history.length === 0 ? (
        <div class="status-bar-history-empty">Nothing yet.</div>
      ) : (
        [...history].reverse().map((entry) => (
          <div class="status-bar-history-row" key={`${entry.ts}-${entry.text}`}>
            <span class="sbh-ts">{new Date(entry.ts).toLocaleTimeString()}</span>
            <span>{entry.text}</span>
          </div>
        ))
      )}
    </div>
  );
}
