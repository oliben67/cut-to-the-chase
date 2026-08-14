---
description: Analyze the change-impact of a specified file across the deployed framework
argument-hint: <file-name>
---

Per `.catalyst-proj/CODE-OF-CONDUCT.md` §3: analyze the change-impact of
`$0` — the current repository state, the file's role in the framework,
and the rules or artifacts that depend on it — then return a concise
impact summary.

1. Resolve `$0` to an actual file in the project (rule file, template,
   requirement, bug, house-keeping item, meta-tag, work item, domain
   file, plugin contract, or other framework asset). If it can't be
   resolved, state that it wasn't found and don't invent a result.
2. Identify what kind of asset it is and where it's indexed (e.g. a rule
   file must appear in its type index and the global
   `.catalyst-proj/rules/rules.md`; a `REQ-`/`BUG-`/`HK-` file must appear
   in its type's index).
3. Search the repository for references to the file's ID/name — index
   entries, cross-links from other artifacts, code comments, tests, and
   (for rules) `Targets` fields on bugs/requirements/house-keeping items
   that cite it.
4. Return a concise summary covering:
   - What the file is and its current status.
   - What else references or depends on it (with file paths).
   - Likely blast radius if it changes or is retired (affected domains,
     open bugs/requirements citing it, missing/broken links found).
   - Any blocking concerns (e.g. an orphaned rule, a dangling reference).
