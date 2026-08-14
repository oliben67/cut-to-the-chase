import "../../shared/legacy-globals";
import { $ } from "../../shared/dollar";
import { dockerHostHistory } from "./state";
import { dockerHostLabel } from "./host-label";
import { renderSelectOptions } from "../../shared/components/SelectOptions";

// Fills the Connect Docker Host dialog's "Load Docker Host" dropdown --
// hidden entirely (rather than just empty) when there's no history yet, so
// a first-time user isn't shown a picker with nothing useful in it.
export async function populateDockerHostHistory(): Promise<void> {
  const history = await dockerHostHistory();
  $("docker-host-history-row").hidden = history.length === 0;
  renderSelectOptions($("docker-host-history"), {
    placeholder: "— pick a previously used Docker host —",
    options: history.map((entry) => ({ value: entry.hostKey, label: dockerHostLabel(entry.hostKey) })),
  });
  $("docker-host-history").value = "";
}
