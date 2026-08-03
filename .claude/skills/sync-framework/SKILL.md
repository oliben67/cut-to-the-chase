---
description: Sync .catalyst-proj/ against the development-framework repo's release branch (optionally a specific tagged version)
argument-hint: [version]
---

Follow the `catalyst` git repository's own
`development-framework/SYNCHRONIZE.md` — specifically its
"Slash-command behavior for `/sync-framework`" and "Synchronization
checklist" sections — exactly; re-read that file first if its process ever
changes, rather than trusting this summary. This command's argument is:
`$0` (a version like `0.1.4`, or empty/unset).

Hard rules on `catalyst` itself: never mention its local drive/folder/path
anywhere (in this command's output, in memory, in any doc) — refer to it
only as the `catalyst` repository; and never push to it without the
user's explicit assent (fetching/pulling/reading is fine).

## Resolve the target version

1. In the local checkout of the `catalyst` repository, run
   `git fetch origin --prune`.
2. If `$0` is non-empty, treat it as the requested version. Check
   `git tag -l '<version>'` / `git ls-remote --tags origin` for a matching
   tag on the `release` lineage. If it doesn't exist, stop and report the
   requested release is unavailable — do not fall back to an unrelated
   version.
3. If `$0` is empty/unset, resolve `release`'s latest tag automatically
   (`git checkout release && git pull --ff-only`, then read
   `development-framework/version.txt` at that tip).
4. Either way, load that version's `development-framework/` content into
   memory (checkout the resolved tag/branch tip locally first if needed).

## Compare against this project's deployment

5. Read this project's `.catalyst-proj/version.txt`.
6. If the resolved version equals the deployed version: still reload the
   framework content fresh (discard any stale in-memory copy) and
   re-synchronize against the present `.catalyst-proj/` contents — don't
   skip just because the version string matches.
7. If it differs: synchronize using the present `.catalyst-proj/` state as
   the baseline, preserving project-local adjustments that are still
   valid (don't blindly overwrite cttc-specific content).

## Apply the synchronization checklist

8. Compare `.catalyst-proj/rules/rules-of-rules.md`,
   `.catalyst-proj/rules/rules-of-development.md`,
   `.catalyst-proj/work-items/rules-of-work-items.md`, and
   `.catalyst-proj/requirements/`'s template against the corresponding
   `development-framework/*.template.md` files at the resolved version.
9. Copy over changed templates/rules/guidance/structure the project
   actually needs — e.g. a rename/relocation like Section→Domain
   (`domains/` lives at `.catalyst-proj/`'s root, a sibling of `rules/`,
   not nested inside it — this moved at least once already, so re-check
   `INSTANTIATION-GUIDE.md`'s current layout rather than assuming), a new
   artifact type (e.g. Meta-tag, `templates/meta-tag.template.md`), or new
   slash-command guidance in `rules-of-development.template.md`. Merge
   deliberately; if a change would conflict with or discard existing
   project-specific content, stop and ask rather than guessing.
10. Confirm `.catalyst-proj/` still has: `requirements/requirements.md` +
    individual `REQ-NNNN.md` files, `development/bugs/bugs.md` +
    individual `BUG-NNNN.md` files, `development/BACKLOG.md`, and its own
    `version.txt`.
11. Update `.catalyst-proj/version.txt` to the resolved version once
    synchronization is complete.
12. Also refresh `.vscode/development-framework/` (the project-local,
    gitignored mirror of the canonical docs) for whatever specific files
    changed — one file at a time, not a wholesale re-copy, per existing
    practice.
13. Update the `cttc-development-framework` memory file with the new
    version/state once done.

Never silently auto-apply a structural rename or a new artifact type
without confirming with the user first — same bar as any other
destructive-ish or hard-to-reverse project change.
