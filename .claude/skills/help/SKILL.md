---
description: List available custom slash commands and artifact types
argument-hint: [command]
---

If `$0` names a specific command, return detailed help for that command
only — its syntax, behavior, and prerequisites (read that command's own
`.claude/skills/<name>/SKILL.md` for the detail). If the name doesn't
match any command below, respond that it's unsupported and suggest the
available commands instead of guessing.

Otherwise, with no argument, list, in a compact reference format, both of
the following (no need to read any files for this — the list is fixed
and known):

## Custom slash commands

| Command | Purpose |
|---|---|
| `/sync-framework [version]` | Sync `.catalyst-proj/` against the catalyst framework's `release` branch (a specific tagged version, or the latest if omitted) |
| `/create-bug: <description>` | File a new `BUG-NNNN` under `development/bugs/` |
| `/create-req:` / `/create-requirement: <description>` | File a new `REQ-NNNN` under `requirements/` (aliases) |
| `/create-epic <description>` | File a new `EPIC-NNNN` under `work-items/epics/` |
| `/create-story <description>` | File a new `STORY-NNNN` under `work-items/stories/` |
| `/create-task <description>` | File a new `TASK-NNNN` under `work-items/tasks/` |
| `/create-spike <description>` | File a new `SPIKE-NNNN` under `work-items/spikes/` |
| `/create-sprint <description>` | File a new `SPRINT-NNN` under `work-items/sprints/` |
| `/meta-tag <artefact-id>` | Create a `comment`/`version`/`link-to` annotation linked to an existing artifact |
| `/status <artefact-id> <status> [force]` | Update an artifact's `Status` field, refusing invalid values unless `force` is given |
| `/run-analysis [recipe]` | Run the analysis playbook to bootstrap rules/domains/bugs from the codebase |
| `/check-rules` | Audit rules, domains, and artifact links for missing targets, conflicts, and broken references |
| `/show-backlog` | Summarize open work, blockers, and index/backlog inconsistencies |
| `/help [command]` | This list, or detail on one command |

## Artifact types

| Type | Folder | ID / filename shape | Purpose |
|---|---|---|---|
| Bug | `development/bugs/` | `BUG-NNNN` | An existing ✅ rule doesn't actually hold in the running app, or formalizes a known ⚠️/❌ rule into trackable work |
| Requirement | `requirements/` | `REQ-NNNN` | An explicit, tracked requirement capturing user/business behavior to implement and test; may propose new rules |
| House-keeping | `development/house-keeping/` | `HK-NNNN` | Dev-support tooling/process work, not product behavior |
| Meta-tag | `development/meta-tags/` | `tag-<key>-<artefact-id>` | Lightweight `comment`/`version`/`link-to` annotation on an existing artifact |
| Epic | `work-items/epics/` | `EPIC-NNNN` | Groups child stories under one or more `DOMAIN` codes; never targets a rule directly |
| Story | `work-items/stories/` | `STORY-NNNN` | Scrum-sized slice of one `REQ-`/`BUG-` doc's work |
| Task | `work-items/tasks/` | `TASK-NNNN` | Implementation detail under one story; inherits its rule target |
| Spike | `work-items/spikes/` | `SPIKE-NNNN` | Time-boxed investigation producing a rule proposal or an estimate, never shipped code |
| Sprint | `work-items/sprints/` | `SPRINT-NNN` | Schedules `STORY-`/`TASK-`/`SPIKE-` items; never restates their content |

Every rule lives in `UI-Rules.md`/`business-rules.md`/`rules-of-rules.md`
as `(ui|br|rr)-(DOMAIN)-(NNN)`, governed by
`.catalyst-proj/rules/rules-of-rules.md`.
