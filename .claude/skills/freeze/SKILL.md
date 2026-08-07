---
description: Protect an item, type, or template from being overwritten by /sync-framework
argument-hint: <item-id|item-path|type|template-name>
---

Per `.catalyst-proj/CODE-OF-CONDUCT.md` §3: resolve `$0` to a backing
file path and add it to `.catalyst-proj/.frozen` so `/sync-framework`
skips it until it's unfrozen or overridden with `--force`.

1. Resolve `$0` against, in order:
   - an exact artifact/work-item/rule ID (e.g. `BUG-0012`, `ui-GATE-016`)
     → that item's individual file path
   - a literal file path already inside `.catalyst-proj/` → itself
   - a known type name (`bug`, `rule`, `epic`, etc.) → that type's whole
     directory, protecting every current and future file under it
   - a template name (`TEMPLATE-BUG.md`, `rule.template.md`, etc.) → that
     template's path
   If none of these resolve, state that `$0` couldn't be matched to
   anything and don't modify `.frozen`.
2. Read `.catalyst-proj/.frozen`. If the resolved path is already listed,
   report that it's already frozen and stop — don't add a duplicate line.
3. Otherwise append the resolved path as a new line and report what was
   frozen and at what scope (single file vs. whole type directory).
4. Remind the user this only affects `/sync-framework` — it doesn't
   protect the file from normal edits, and a future `/sync-framework
   --force <type|item-id|all>` will still refresh it.
