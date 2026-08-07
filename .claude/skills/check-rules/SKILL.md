---
description: Verify rules, domains, and artifact links stay consistent and don't conflict
---

Per `.catalyst-proj/CODE-OF-CONDUCT.md` §3: inspect the
deployed `.catalyst-proj/` framework for missing rule targets, conflicting
domains, missing indexes, and broken cross-references, then report the
result — a read-only audit, don't modify anything unless asked to fix
what's found.

Check, in order:

1. **Every `BUG-`/`REQ-`/`HK-` item has a non-empty `Targets` field**
   citing at least one existing rule ID (per `Rules-of-Rules.md`'s
   `ui-`/`br-`/`rr-` scheme) — per `CODE-OF-CONDUCT.md` §1. Flag any
   item with an empty, missing, or dangling (non-existent rule ID)
   `Targets` field, except house-keeping items that explicitly state "no
   rule applies."
2. **Every `Domain` field** on those items resolves to a real code in
   `.catalyst-proj/domains/domains.md` / the domain tables in
   `Rules-of-Rules.md`.
3. **Every domain in `domains/`** has a corresponding entry in
   `domains/domains.md` and vice versa — the directory and the index must
   not drift apart (per `Rules-of-Rules.md` §7 step 3).
4. **Every index file is complete**: `bugs/bugs.md`,
   `requirements/requirements.md`, `features/features.md`,
   `house-keeping/house-keeping.md`,
   `meta-tags/meta-tags.md`, `domains/domains.md`, and the work-items
   indexes (`epics.md`/`stories.md`/`tasks.md`/`spikes.md`/`sprints.md`)
   each list every individual file actually present in their directory,
   with no stale rows for files that no longer exist.
5. **No duplicate or reused IDs** within any artifact/work-item type.
6. **Relative markdown links resolve** — spot-check a sample of
   `[...](...)` links across `rules/`, `development/`, `requirements/`,
   `domains/`, and `work-items/` for files that don't exist at the
   resolved path.
7. **No rule marked 🗑 retired is still cited as a live `Targets`** by a
   non-historical item opened after its retirement date (per
   `Rules-of-Rules.md` §4 and `CODE-OF-CONDUCT.md` §7 — retired
   rules stay valid on pre-existing items, but a *new* item shouldn't
   target one unless the item is about the retirement itself).

Report findings grouped by check, each with the specific file(s)
involved — not a pass/fail summary with no detail.
