---
description: Create a meta-tag annotation linked to an existing artifact
argument-hint: <artefact-id>
---

Per `.catalyst-proj/rules/rules-of-development.md` §3: create a new
meta-tag artifact immediately for the artifact ID in `$0`, save it, and
link it to that artifact.

1. Confirm `$0` resolves to a real existing artifact (a `BUG-`/`REQ-`/
   `HK-` ID, a rule ID, or another meta-tag). If it doesn't resolve, say so
   and stop — don't create a dangling tag.
2. If the key (`comment` / `version` / `link-to`) wasn't supplied
   alongside `$0`, prompt for it before creating anything.
3. Read `.catalyst-proj/development/meta-tags/TEMPLATE-META-TAG.md` for
   the required structure.
4. Create `.catalyst-proj/development/meta-tags/tag-<key>-<artefact-id>.md`
   following the template, filled in with the resolved key/value and a
   pointer back to the target artifact.
5. Add a row to `.catalyst-proj/development/meta-tags/meta-tags.md`'s
   index table — but if the target artifact also benefits from a visible
   cross-reference (e.g. a `Related` field), add one there too.
6. Only require a `Targets` rule ID on the meta-tag itself if the artifact
   it annotates is itself rule-linked (a bug/requirement) — a meta-tag on
   a purely process artifact (e.g. house-keeping) doesn't need one.
