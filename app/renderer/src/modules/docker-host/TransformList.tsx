import { render } from "preact";
import { formatTransformName } from "../../shared/format";

export interface TransformItem {
  name: string;
  doc?: string;
  checked: boolean;
}

// Pure, prop-driven -- checked state is resolved by the caller (carrying
// over whatever was already ticked, same as before this was extracted)
// and passed in fully resolved, not computed here. `checked` only sets
// the checkbox's initial state at render time (no onChange, see rule 6 in
// the refactor plan) -- chosenTransforms() keeps reading the live DOM
// afterward, exactly as before, so a user's/test's own tick between
// rebuilds survives untouched.
export function TransformList({ transforms }: { transforms: TransformItem[] }) {
  if (transforms.length === 0) return <>none found</>;
  return (
    <>
      {transforms.map((tr) => (
        <label key={tr.name}>
          <input type="checkbox" value={tr.name} checked={tr.checked} />
          {` ${formatTransformName(tr.name)} `}
          <span class="tdoc">{tr.doc || ""}</span>
        </label>
      ))}
    </>
  );
}

export function renderTransformList(container: HTMLElement, transforms: TransformItem[]): void {
  render(<TransformList transforms={transforms} />, container);
}
