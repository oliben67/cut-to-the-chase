import { render } from "preact";

export interface DockerTargetItem {
  name: string;
  id?: string;
  image?: string;
  replicas?: string;
  // Only meaningful for a group's `items` -- `missing` entries are always
  // forced checked+disabled regardless of this field.
  checked?: boolean;
}

function setCheckedWithMark(cb: HTMLInputElement, mark: HTMLElement, checked: boolean): void {
  cb.checked = checked;
  mark.textContent = checked ? "✔" : "";
}

// One labelled group of checkboxes (Swarm services / Containers) inside
// #docker-targets. The group header's select-all-in-group click and each
// checkbox's own change handler mutate the already-rendered DOM nodes
// directly (via a plain callback ref on each <label>, not component state)
// rather than triggering a re-render -- per the refactor plan's rule 2, a
// re-render only ever happens at an explicit Fetch/Refresh/open rebuild
// point (see DockerTargetList below), never from a click. This is what
// lets a test capture checkbox node references before a group click and
// still see them reflect the click afterward, exactly as the imperative
// version did.
//
// Deliberately no other visual distinction for a plain, present,
// checked/unchecked entry (no dimming, no "already added" label, same
// color/enabled either way) -- the ✔/🚫 marks are the only cue.
function DockerTargetGroup({
  title,
  items,
  type,
  missing,
  onChange,
}: {
  title: string;
  items: DockerTargetItem[];
  type: string;
  missing: DockerTargetItem[];
  onChange: () => void;
}) {
  if (!items.length && !missing.length) return null;
  const pairs: Array<{ cb: HTMLInputElement; mark: HTMLElement }> = [];
  return (
    <>
      <div
        class="group"
        title="Click to select/deselect all of this group"
        onClick={() => {
          const selectAll = pairs.some(({ cb }) => !cb.checked);
          for (const { cb, mark } of pairs) setCheckedWithMark(cb, mark, selectAll);
          onChange();
        }}
      >
        {title}
      </div>
      {items.map((it) => (
        <label
          key={it.name}
          ref={(el) => {
            if (!el) return;
            const cb = el.querySelector("input") as HTMLInputElement;
            const mark = el.querySelector(".mark") as HTMLElement;
            // Fresh checkboxes are always enabled regardless of fetch state
            // (setDockerFormEnabled sweeps separately, see set-dialog.ts) --
            // forced here, not left to Preact's own prop diffing, because a
            // same-named item across two renders reuses this DOM node by
            // key: an external `cb.disabled = true` write from *before*
            // this render (listContainers disables the whole form while a
            // fetch is in flight) would otherwise survive the reuse, since
            // neither render's vnode ever declares a `disabled` prop for it
            // to diff against.
            cb.disabled = false;
            pairs.push({ cb, mark });
          }}
        >
          <input
            type="checkbox"
            value={it.name}
            data-type={type}
            checked={it.checked}
            onChange={(e) => {
              const cb = e.currentTarget;
              const mark = cb.parentElement!.querySelector(".mark") as HTMLElement;
              setCheckedWithMark(cb, mark, cb.checked);
              onChange();
            }}
          />
          <span class="mark">{it.checked ? "✔" : ""}</span>
          {` ${it.name} `}
          <span class="tdoc">{it.image || it.replicas || ""}</span>
        </label>
      ))}
      {missing.map((it) => (
        <label class="unavailable" key={`missing-${it.name}`}>
          <input type="checkbox" value={it.name} data-type={type} checked disabled />
          <span class="mark">🚫</span>
          {` ${it.name} `}
          <span class="tdoc">no longer available</span>
        </label>
      ))}
    </>
  );
}

// Repopulates #docker-targets -- Swarm services group, then Containers
// group, empty state otherwise. All the actual *logic* (checked-state
// carry-over/diffing against selectedTargets, missing detection, closing
// now-gone sources) stays in set-dialog.ts's renderDockerTargets, which
// resolves each item's final `checked` before calling renderDockerTargetList
// below -- this component is a pure function of already-resolved props.
export function DockerTargetList({
  services,
  containers,
  missingServices,
  missingContainers,
  onChange,
}: {
  services: DockerTargetItem[];
  containers: DockerTargetItem[];
  missingServices: DockerTargetItem[];
  missingContainers: DockerTargetItem[];
  onChange: () => void;
}) {
  if (!services.length && !containers.length && !missingServices.length && !missingContainers.length) {
    return <>nothing running</>;
  }
  return (
    <>
      <DockerTargetGroup title="Swarm services (docker service logs)" items={services} type="service" missing={missingServices} onChange={onChange} />
      <DockerTargetGroup title="Containers (docker logs)" items={containers} type="container" missing={missingContainers} onChange={onChange} />
    </>
  );
}

export function renderDockerTargetList(
  container: HTMLElement,
  props: {
    services: DockerTargetItem[];
    containers: DockerTargetItem[];
    missingServices: DockerTargetItem[];
    missingContainers: DockerTargetItem[];
    onChange: () => void;
  },
): void {
  render(<DockerTargetList {...props} />, container);
}

// Truly empty (innerHTML === "") -- distinct from rendering DockerTargetList
// with all-empty arrays, which shows "nothing running" text. Used to reset
// #docker-targets back to blank (New Docker Host opening, a Fetch/Refresh
// that failed outright) without a raw innerHTML= write, which would fight
// Preact's own bookkeeping for this container once it's rendered here once.
export function clearDockerTargetList(container: HTMLElement): void {
  render(null, container);
}
