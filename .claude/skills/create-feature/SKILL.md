---
description: File a new FEAT-NNNN artifact under .catalyst-proj/features/
argument-hint: <description>
---

Per `.catalyst-proj/CODE-OF-CONDUCT.md` §3 ("Slash-command
entry points"): create a new feature entry immediately from the
description in `$0`, register it in `features/features.md`, and track it
as idea/roadmap content — don't just describe what you'd do, actually
create the file.

Unlike `/create-bug`/`/create-req`, never prompt for a `Domain` or rule
`Targets` — neither field exists on this artifact type. Feature entries
are exempt from `Rules-of-Rules.md` §1's conflict check and from
`CODE-OF-CONDUCT.md` §1 ("no development without a targeted rule") — see
`.catalyst-proj/rules/Rules-of-Rules.md` §9.

1. Read `.catalyst-proj/features/TEMPLATE-FEATURE.md` for the required
   structure (ID/Status/Opened/Area/Requirement(s) table, Description,
   Motivation, Rough scope, Open questions, Related).
2. Find the next unused `FEAT-NNNN` (check both
   `.catalyst-proj/features/features.md` and the existing individual
   files — never reuse or renumber).
3. Create `.catalyst-proj/features/FEAT-NNNN-short-slug.md` following the
   template, leaving `Requirement(s)` empty (it's filled in only once a
   `REQ-NNNN` is opened against this feature).
4. Add a row to `.catalyst-proj/features/features.md`'s index table.

Always create an individual `FEAT-NNNN.md` file plus an index entry —
never a single bundled document, and never just a bullet appended
somewhere else. If the user later asks to start building a registered
feature, use `/create-req` instead (prompting for domain/target rule as
usual per that command), and link the resulting `REQ-NNNN` back into this
feature's `Requirement(s)` field.
