---
description: File a new SPIKE-NNNN artifact under .catalyst-proj/work-items/spikes/
argument-hint: <description>
---

Per `.catalyst-proj/work-items/rules-of-work-items.md` §3 and
`.catalyst-proj/rules/rules-of-development.md` §3: create a new spike
immediately from the description in `$0`, register it in
`work-items/spikes/spikes.md`, and track it the same way as any other
work item — don't just describe what you'd do, actually create the file.

1. Read `.catalyst-proj/work-items/spikes/TEMPLATE-SPIKE.md` for the
   required structure (ID/Status/Parent/Timebox/Related rule(s) table,
   Question).
2. Determine the `Parent` — the `STORY-NNNN` or `EPIC-NNNN` this spike
   unblocks.
3. Determine the `Timebox` — a hard stop, not an estimate. If `$0`
   doesn't specify one, ask.
4. A spike is time-boxed research, never itself "implements" anything
   (per `rules-of-work-items.md` §3) — its outcome is a new rule
   proposal, an estimate, or a decision not to pursue the parent. If the
   work described in `$0` sounds like it will produce production code,
   flag that this should be a story/task instead.
5. Find the next unused `SPIKE-NNNN` (check both
   `.catalyst-proj/work-items/spikes/spikes.md` and the existing files —
   never reuse or renumber).
6. Create `.catalyst-proj/work-items/spikes/SPIKE-NNNN-short-slug.md`
   following the template.
7. Add a row to `.catalyst-proj/work-items/spikes/spikes.md`'s index
   table.
