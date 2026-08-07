---
description: Summarize open work, blockers, and missing links from BACKLOG.md and the artifact indexes
---

Per `.catalyst-proj/CODE-OF-CONDUCT.md` §3: inspect
`.catalyst-proj/development/BACKLOG.md` and the artifact indexes, then
summarize the relevant open work and blockers — a read-only report, don't
modify anything.

1. Read `.catalyst-proj/development/BACKLOG.md` for the current
   prioritized, severity-ranked view.
2. Cross-check it against `development/bugs/bugs.md`,
   `requirements/requirements.md`, and `development/house-keeping/house-keeping.md`
   — flag any open item present in an index but missing from
   `BACKLOG.md` (or vice versa), since `BACKLOG.md` doesn't replace the
   indexes (per `CODE-OF-CONDUCT.md` §2) but should stay consistent
   with them for anything still open.
3. If the Scrum layer is in use, also check
   `work-items/sprints/sprints.md` for the active sprint's committed
   items and flag any that are blocked or stalled.
4. Summarize: what's open, ranked by the priority `BACKLOG.md` already
   assigns; what's blocked and why (dependency on another item, missing
   rule, waiting on a decision); and any inconsistency found in step 2.
   Cite specific IDs — not a vague headcount.
