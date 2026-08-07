---
description: Update an artifact's Status field, with an optional force override
argument-hint: <artefact-id> <status> [force]
---

Per `.catalyst-proj/CODE-OF-CONDUCT.md` §3: update the
`Status` field of artifact `$0` to `$1`. If a third word `force` is
present (`$2`), that's the force override.

1. Resolve `$0` to an existing artifact file (search
   `.catalyst-proj/development/bugs/`, `.catalyst-proj/requirements/`,
   `.catalyst-proj/features/`, `.catalyst-proj/development/house-keeping/`,
   `.catalyst-proj/development/meta-tags/`, or `.catalyst-proj/work-items/`
   as appropriate for the ID's prefix). If nothing resolves, state that the
   artifact cannot be found and stop — do not modify anything.
2. Determine the valid status values for that artifact's type (e.g. bugs:
   `open`/`in-progress`/`fixed`/`wontfix`/`duplicate-of BUG-xxxx`;
   requirements/house-keeping/work-items: whatever their own template
   documents).
3. If `$1` is one of the valid statuses for that type, update the file's
   `Status` field normally, and update the corresponding index
   (`bugs/bugs.md` / `requirements/requirements.md`) if that index tracks
   status.
4. If `$1` is not a valid status:
   - If `force` was supplied, apply it anyway (the artifact's `Status`
     field becomes that literal value, even though it's outside the
     documented set).
   - If `force` was not supplied, respond that the status change is
     impossible (naming the valid values) and make no changes.
5. Never silently coerce an invalid status into the nearest valid one —
   either it's a recognized value, forced through explicitly, or refused.
