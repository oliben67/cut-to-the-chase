---
description: File a new REQ-NNNN artifact under .catalyst-proj/requirements/
argument-hint: <description>
---

Per `.catalyst-proj/rules/rules-of-development.md` §3 ("Slash-command
entry points"): create a new requirement artifact immediately from the
description in `$0`, register it in `requirements/requirements.md`, and
track it in the same workflow as any other requirement — don't just
describe what you'd do, actually create the file. (Same behavior as
`/create-requirement:` — the two are aliases.)

1. Read `.catalyst-proj/requirements/TEMPLATE-REQUIREMENT.md` for the
   required structure (ID/Status/Source rule(s)/Area table, Description,
   Acceptance criteria where applicable, Status, Related).
2. Determine the `Targets`/source rule ID(s) this requirement captures or
   extends. If none exist yet and this requirement also proposes new
   rules, note them inline per
   `.catalyst-proj/rules/rules-of-development.md` §1 — new rules
   must satisfy `rules-of-rules.md` §1's conflict check before being
   treated as real.
3. Determine the `Domain`/`Area` this requirement belongs to (the `DOMAIN`
   code from `.catalyst-proj/rules/rules-of-rules.md`'s domain tables). If
   it can't be inferred from `$0` and context, ask.
4. Find the next unused `REQ-NNNN` (check both
   `.catalyst-proj/requirements/requirements.md` and the existing
   individual files — never reuse or renumber).
5. Create `.catalyst-proj/requirements/REQ-NNNN-short-slug.md` following
   the template.
6. Add a row to `.catalyst-proj/requirements/requirements.md`'s index
   table.

Always create an individual `REQ-NNNN.md` file plus an index entry — never
a single bundled requirements document, and never just a bullet appended
somewhere else.
