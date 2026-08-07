---
description: File a new TASK-NNNN artifact under .catalyst-proj/work-items/tasks/
argument-hint: <description>
---

Per `.catalyst-proj/work-items/rules-of-work-items.md` §2 and
`.catalyst-proj/CODE-OF-CONDUCT.md` §3: create a new task
immediately from the description in `$0`, register it in
`work-items/tasks/tasks.md`, and track it the same way as any other work
item — don't just describe what you'd do, actually create the file.

1. Read `.catalyst-proj/work-items/tasks/TEMPLATE-TASK.md` for the
   required structure (ID/Status/Parent/Assignee/Estimate table,
   Description).
2. Determine the `Parent` `STORY-NNNN` — a task always has exactly one
   parent story (per `rules-of-work-items.md` §2). If there isn't one
   yet, create it first (see `/create-story`). Technical/house-keeping
   work with no story goes under `development/house-keeping/HK-NNNN`
   directly instead, not a task.
3. A task never gets its own `Targets` field — it inherits its parent
   story's rule target. If the work needs a rule the parent story doesn't
   cover, stop and fix the story/requirement doc first rather than
   letting scope creep in unreviewed.
4. Find the next unused `TASK-NNNN` (check both
   `.catalyst-proj/work-items/tasks/tasks.md` and the existing files —
   never reuse or renumber).
5. Create `.catalyst-proj/work-items/tasks/TASK-NNNN-short-slug.md`
   following the template.
6. Add a row to `.catalyst-proj/work-items/tasks/tasks.md`'s index table.
