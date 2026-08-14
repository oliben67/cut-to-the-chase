import { atom } from "jotai";

export const DEFAULT_STATUS_BAR_VISIBLE = true;
export const STATUS_BAR_HISTORY_MAX = 500;

export interface StatusBarHistoryEntry {
  ts: number;
  text: string;
}

// The real, single history array -- kept as a plain mutable array (not an
// atom) because renderer-spec.js manipulates it directly by reference
// (`statusBarHistory.length = 0`, `.map()`, `.at(-1)`, indexing), exactly
// as it does with every other legacy app.js global. HistoryList is driven
// by explicit render() calls off this array (see status-bar.actions.ts),
// not a reactive atom subscription -- app.js's whole synchronous-update
// assumption (every state-changing call reflects in the DOM before it
// returns, no microtask deferral) doesn't mix with Preact's normal
// hooks-based batching, so this module uses Preact only for declarative
// rendering, driven imperatively, not for reactive re-rendering.
export const statusBarHistory: StatusBarHistoryEntry[] = [];

// Appearance > Status bar toggle. Also controls the shared #app-status-bar
// container's hidden attribute (which the recording dot / gateway pill /
// docker host pill / live-mode icon live inside too), same as today.
export const statusBarVisibleAtom = atom<boolean>(DEFAULT_STATUS_BAR_VISIBLE);

// History popup open/closed -- genuinely local UI state, owned outright.
// Read only via the vanilla store (get/sub), never a component hook -- see
// the comment on statusBarHistory above for why.
export const historyPopupOpenAtom = atom<boolean>(false);
