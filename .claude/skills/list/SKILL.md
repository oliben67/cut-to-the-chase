---
description: List artifacts, work items, rules, or templates, with optional property filters
argument-hint: <type> [--filter key=value ...]
---

Per `.catalyst-proj/CODE-OF-CONDUCT.md` §3: list items of type `$0`
(`bug`/`requirement`/`feature`/`house-keeping`/`meta-tag`/`epic`/`story`/`task`/
`spike`/`sprint`/`rule`/`template`/`all`), applying every `--filter
key=value` or `--filter key="value*"` given.

1. Resolve `$0` to its backing collection(s):
   - `bug` → `.catalyst-proj/development/bugs/bugs.md` + individual files
   - `requirement` → `.catalyst-proj/requirements/requirements.md` + files
   - `feature` → `.catalyst-proj/features/features.md` + individual files
   - `house-keeping` → `.catalyst-proj/development/house-keeping/house-keeping.md` + files
   - `meta-tag` → `.catalyst-proj/development/meta-tags/meta-tags.md` + files
   - `epic`/`story`/`task`/`spike`/`sprint` → the matching
     `.catalyst-proj/work-items/<type>s/<type>s.md` index + files
   - `rule` → `.catalyst-proj/rules/rules.md`, then
     `.catalyst-proj/rules/ui/ui-rules.md` and
     `.catalyst-proj/rules/business/business-rules.md`
   - `template` → requires an additional `--type <template-type>`
     argument (e.g. `bug`, `rule`, `epic`) to pick which
     `TEMPLATE-*.md`/`rule.template.md`-family file to show; without it,
     ask which template type before listing anything
   - `all` → every collection above
2. If `$0` doesn't match any known type, state that it's unsupported and
   list the valid types rather than guessing.
3. Read the relevant index file(s) (and individual files if a filter
   needs a field not present in the index row, e.g. filtering rules by
   `Status`).
4. Apply every `key=value` filter as an exact match on that field;
   `key="value*"` as a prefix match. Filters combine with AND. Filtering
   on an unknown field name: state that the field doesn't exist for this
   type rather than silently ignoring the filter.
5. Return the matching rows in a compact table (ID/title/status/path, or
   whatever columns that type's index already uses). If nothing matches,
   say so explicitly — an empty result is a valid answer, not an error.
