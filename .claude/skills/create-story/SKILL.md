---
description: File a new STORY-NNNN artifact under .catalyst-proj/work-items/stories/
argument-hint: <description>
---

Per `.catalyst-proj/work-items/rules-of-work-items.md` §1 and
`.catalyst-proj/CODE-OF-CONDUCT.md` §3: create a new story
immediately from the description in `$0`, register it in
`work-items/stories/stories.md`, and track it the same way as any other
work item — don't just describe what you'd do, actually create the file.

1. Read `.catalyst-proj/work-items/stories/TEMPLATE-STORY.md` for the
   required structure (ID/Status/Epic/Targets/Requirement doc/Points/
   Domain table, Story, Acceptance criteria).
2. Determine the **Requirement doc** — the `REQ-NNNN` (or `BUG-NNNN` for
   "fix this properly" work) this story implements. A story is never a
   substitute for that doc (per `rules-of-work-items.md` §1) — if one
   doesn't exist yet, create it first (see `/create-req`) before creating
   the story.
3. Determine the `Targets` rule ID(s) and `Domain` from that requirement
   or bug doc.
4. Determine the `Epic` field, if this story belongs to one (or state
   "none").
5. Find the next unused `STORY-NNNN` (check both
   `.catalyst-proj/work-items/stories/stories.md` and the existing files
   — never reuse or renumber).
6. Create `.catalyst-proj/work-items/stories/STORY-NNNN-short-slug.md`
   following the template.
7. Add a row to `.catalyst-proj/work-items/stories/stories.md`'s index
   table.

Never create a story without a `REQ-`/`BUG-` doc behind it — that is the
Scrum-layer expression of "no development without a targeted rule" (per
`CODE-OF-CONDUCT.md` §1).
