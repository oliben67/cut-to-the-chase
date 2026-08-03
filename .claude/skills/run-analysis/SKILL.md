---
description: Run the catalyst framework's analysis playbook to bootstrap rules/domains/bugs from the codebase
argument-hint: [recipe or focus area]
---

Per `.catalyst-proj/rules/rules-of-development.md` §3: open and run
[`ANALYSIS-PLAYBOOK.md`](../../.vscode/development-framework/ANALYSIS-PLAYBOOK.md)
against this project, following its steps and returning the resulting
analysis summary. If the playbook file is missing from the mirror, report
that it's unavailable — do not invent its content from memory.

1. Read `.vscode/development-framework/ANALYSIS-PLAYBOOK.md` in full.
2. If `$0` names a specific recipe or focus area, run that recipe only;
   otherwise ask which recipe applies (rule extraction, domain
   extraction, bug/backlog extraction, etc. — per the playbook's own
   table of contents) rather than guessing scope.
3. Follow the playbook's four-eyes principle exactly: launch the
   independent Agent pairs it specifies with `run_in_background: true`
   in the same message, `subagent_type: general-purpose`, `model: opus`,
   and the same prompt verbatim for both agents — then run its
   reconciliation pass once both return.
4. Output of a rule-extraction pass is individual `REQ-NNNN-slug.md`
   files under `.catalyst-proj/requirements/` plus an index entry in
   `requirements/requirements.md` — never one bundled document (per
   `rules-of-development.md`'s hard rule on individual files and
   indexes).
5. Any newly identified domain gets its own
   `.catalyst-proj/domains/<prefix>-<CODE>.md` file (copy
   `domains/TEMPLATE-DOMAIN.md`) and an entry in `domains/domains.md`,
   per `rules-of-rules.md` §6, before any rule bullet cites it.
6. Report a summary of what was extracted/created — don't just say the
   playbook ran; name the specific files added or updated.
