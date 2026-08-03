---
description: File a new SPRINT-NNN container under .catalyst-proj/work-items/sprints/
argument-hint: <description>
---

Per `.catalyst-proj/work-items/rules-of-work-items.md` §5 and
`.catalyst-proj/rules/rules-of-development.md` §3: create a new sprint
immediately from the description in `$0`, register it in
`work-items/sprints/sprints.md`, and track it the same way as any other
work item — don't just describe what you'd do, actually create the file.

1. Read `.catalyst-proj/work-items/sprints/TEMPLATE-SPRINT.md` for the
   required structure (ID/Dates/Status table, Sprint goal, Committed
   items).
2. Determine the `Dates` and `Sprint goal` from `$0` (ask if not clear).
3. Populate **Committed items** with `STORY-`/`TASK-` IDs (occasionally a
   `SPIKE-`) pulled in as-is — never restate their acceptance criteria or
   rule targets here (per `rules-of-work-items.md` §5); those live on the
   item itself.
4. Find the next unused `SPRINT-NNN` (3-digit, check both
   `.catalyst-proj/work-items/sprints/sprints.md` and the existing files
   — never reuse or renumber; sprints use a 3-digit sequence, distinct
   from every other work-item type's 4-digit `NNNN`).
5. Create `.catalyst-proj/work-items/sprints/SPRINT-NNN-short-slug.md`
   following the template.
6. Add a row to `.catalyst-proj/work-items/sprints/sprints.md`'s index
   table.

Retro action items that imply a process change get filed as
`development/house-keeping/HK-NNNN` (per `rules-of-work-items.md` §5),
never left as only a retro bullet in the sprint doc.
