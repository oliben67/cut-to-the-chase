import { computePosition, flip, shift, offset, type VirtualElement } from "@floating-ui/dom";

// Legend/chart-time menus, and the gateway/docker-host pills' right-click
// menus (see modules/gateway/pill.ts, modules/docker-host/pill.ts) all
// share this one implementation. Ported from app.js's former ~L786-868,
// with @floating-ui/dom replacing the hand-rolled Math.min(...) viewport
// clamp -- proper flip/shift collision handling instead of a clamp that
// only ever pushed the menu up-and-left, never flipped it to the other
// side of the cursor.
//
// entries: [label, fn] or [label, fn, icon] -- icon, when given, is either
// a CSS selector for an existing action-bar button whose own .ab-icon
// markup gets reused (cloned) to the left of the label (so the menu's icon
// can never drift out of sync with the button it duplicates), or a raw
// "<svg ...>...</svg>" string for an entry with no corresponding button to
// clone from. The literal string "separator" in place of an entry renders
// a thin divider instead. A selector-sourced entry also mirrors that
// button's own .disabled -- same reasoning as the icon.
//
// ownerId: opaque tag identifying which caller opened this menu (only the
// Gateway/Docker Host pills pass one, see shared/toolbar-pills) -- left
// off entirely by the legend/chart-time menus, which don't care.
export type CtxMenuEntry = [string, () => void, string?] | "separator";

let ctxEl: HTMLElement | null = null;

export function closeCtxMenu(): void {
  ctxEl?.remove();
  ctxEl = null;
}

export function ctxMenu(e: MouseEvent, entries: CtxMenuEntry[], ownerId?: string): void {
  e.preventDefault();
  e.stopPropagation();
  closeCtxMenu();
  const el = document.createElement("div");
  el.id = "ctxmenu";
  if (ownerId) el.dataset.owner = ownerId;
  for (const entry of entries) {
    if (entry === "separator") {
      const sep = document.createElement("div");
      sep.className = "ctxmenu-sep";
      el.appendChild(sep);
      continue;
    }
    const [label, fn, icon] = entry;
    const b = document.createElement("button");
    let iconEl: HTMLElement | null = null;
    let sourceBtn: HTMLButtonElement | null = null;
    if (icon?.startsWith?.("<svg")) {
      // Wrapped in a <span>, same shape as the cloned .ab-icon <span>
      // below -- keeps a single ".ctxmenu-icon svg" CSS rule working for
      // both, and avoids setting .className directly on the parsed <svg>
      // itself (SVGElement.className is a read-only SVGAnimatedString,
      // unlike a plain HTMLElement's).
      iconEl = document.createElement("span");
      iconEl.innerHTML = icon;
    } else {
      sourceBtn = icon ? document.querySelector<HTMLButtonElement>(icon) : null;
      const abIcon = sourceBtn?.querySelector(".ab-icon");
      if (abIcon) iconEl = abIcon.cloneNode(true) as HTMLElement;
    }
    if (iconEl) {
      iconEl.className = "ctxmenu-icon";
      b.appendChild(iconEl);
    }
    const text = document.createElement("span");
    text.textContent = label;
    b.appendChild(text);
    if (sourceBtn?.disabled) {
      b.disabled = true;
    } else {
      b.onclick = () => { closeCtxMenu(); fn(); };
    }
    el.appendChild(b);
  }

  // Synchronous open at the cursor -- same as the original, so anything
  // checking #ctxmenu exists immediately after the triggering event (no
  // await; renderer-spec.js does this repeatedly) still sees it land in
  // the same tick, regardless of how the position gets refined afterward.
  el.style.left = `${e.clientX}px`;
  el.style.top = `${e.clientY}px`;
  document.body.appendChild(el);
  ctxEl = el;

  // Floating UI then measures the menu's real size against the viewport
  // and refines the position -- necessarily async (computePosition reads
  // real layout), so this runs after the synchronous open above, not
  // instead of it. A virtual reference (not a real element) since there's
  // nothing to anchor to but the click point itself.
  const virtualRef: VirtualElement = {
    getBoundingClientRect: () => ({
      width: 0, height: 0,
      x: e.clientX, y: e.clientY,
      top: e.clientY, left: e.clientX, right: e.clientX, bottom: e.clientY,
    }),
  };
  computePosition(virtualRef, el, {
    placement: "bottom-start",
    middleware: [offset(2), flip(), shift({ padding: 6 })],
  }).then(({ x, y }) => {
    if (ctxEl !== el) return; // closed (or replaced by a newer menu) before this resolved
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  });
}
