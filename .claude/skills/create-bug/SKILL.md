---
description: File a new BUG-NNNN artifact under .catalyst-proj/development/bugs/
argument-hint: <description>
---

Per `.catalyst-proj/CODE-OF-CONDUCT.md` §3 ("Slash-command
entry points"): create a new bug artifact immediately from the description
in `$0`, register it in `bugs/bugs.md`, and track it in the same workflow
as any other bug — don't just describe what you'd do, actually create the
file.

1. Read `.catalyst-proj/development/bugs/TEMPLATE-BUG.md` for the required
   structure (ID/Filename/Status/Severity/Opened/Targets/Domain/Area table,
   Description, Reproduction, Expected vs actual, Root cause, Fix plan,
   Test plan, Related).
2. Determine the `Targets` rule ID(s) this bug violates — per
   `CODE-OF-CONDUCT.md` §1, this is required and can never be empty.
   If it can't be inferred from `$0` and the current conversation context,
   stop and ask which rule(s) (`ui-`/`br-`/`rr-`) this bug violates before
   creating anything.
3. Determine the `Domain` field (the `DOMAIN` code of the targeted rule(s),
   from `.catalyst-proj/rules/Rules-of-Rules.md`'s domain tables). If it
   can't be inferred, ask.
4. Find the next unused `BUG-NNNN` (check both
   `.catalyst-proj/development/bugs/bugs.md` and the existing files —
   never reuse or renumber).
5. Create `.catalyst-proj/development/bugs/BUG-NNNN-short-slug.md`
   following the template, filled in with everything known so far
   (Root cause/Fix plan/Test plan may be "TBD" if not yet investigated —
   Status should reflect that honestly, e.g. `open`, not `fixed`).
6. Add a row to `.catalyst-proj/development/bugs/bugs.md`'s index table.
7. Mention it in `.catalyst-proj/development/BACKLOG.md` if it belongs in
   the prioritized view (per that file's own severity-ranked structure).

Never skip the `Targets` rule ID requirement — a bug with no rule to point
at means the rule needs to be written down first (Rules-of-Rules.md §1),
not that this step gets left blank.
