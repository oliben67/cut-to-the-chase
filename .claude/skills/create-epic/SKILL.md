---
description: File a new EPIC-NNNN artifact under .catalyst-proj/work-items/epics/
argument-hint: <description>
---

Per `.catalyst-proj/work-items/rules-of-work-items.md` §4 and
`.catalyst-proj/CODE-OF-CONDUCT.md` §3: create a new epic
immediately from the description in `$0`, register it in
`work-items/epics/epics.md`, and track it the same way as any other work
item — don't just describe what you'd do, actually create the file.

1. Read `.catalyst-proj/work-items/epics/TEMPLATE-EPIC.md` for the
   required structure (ID/Status/Opened/Domain(s)/Sponsor table, Goal).
2. Determine the `Domain(s)` field — the `DOMAIN` code(s) this epic spans,
   from `.catalyst-proj/rules/Rules-of-Rules.md`'s domain tables. An epic
   never targets a rule directly (per `rules-of-work-items.md` §4); it
   only names the domain(s) its child stories will live in.
3. Find the next unused `EPIC-NNNN` (check both
   `.catalyst-proj/work-items/epics/epics.md` and the existing files —
   never reuse or renumber).
4. Create `.catalyst-proj/work-items/epics/EPIC-NNNN-short-slug.md`
   following the template.
5. Add a row to `.catalyst-proj/work-items/epics/epics.md`'s index table.

An epic is decomposition only — it is "done" when all its child stories
are done, nothing more layered on top (per `rules-of-work-items.md` §4).
