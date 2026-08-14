import { render } from "preact";

export interface SelectOption {
  value: string;
  label: string;
}

// Pure, prop-driven -- the "clear, placeholder option, one option per
// entry" shape shared by every <select> populator in this codebase (see
// renderSelectOptions below for the imperative wrapper that actually
// mounts this into a live <select>).
export function SelectOptions({ placeholder, options }: { placeholder: string; options: SelectOption[] }) {
  return (
    <>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option value={o.value} key={o.value}>{o.label}</option>
      ))}
    </>
  );
}

// Mounts SelectOptions directly into `select` (the <select> element itself
// as Preact's render() container) -- the element stays exactly the same
// node, only its <option> children are replaced. Callers still restore/
// blank `select.value` themselves afterward (rebuilding the options resets
// it), same as before this was extracted.
export function renderSelectOptions(select: HTMLSelectElement, props: { placeholder: string; options: SelectOption[] }): void {
  render(<SelectOptions {...props} />, select);
}
