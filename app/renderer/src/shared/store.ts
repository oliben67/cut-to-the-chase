import { createStore, Provider } from "jotai";
import type { ComponentChildren } from "preact";

// One process-wide Jotai store, created once. Modules import `store`
// directly for imperative reads/writes from non-component code (legacy
// bridge functions, event handlers outside the component tree); the
// `StoreProvider` wraps it for components that use `useAtom`/`useAtomValue`.
export const store = createStore();

export function StoreProvider({ children }: { children: ComponentChildren }) {
  return Provider({ store, children });
}
