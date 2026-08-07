---
description: Manage plugin installation and activation through the catalyst framework interface
argument-hint: <list|activate|download|deactivate|upgrade|downgrade> [name] [version|latest]
---

Per `.catalyst-proj/CODE-OF-CONDUCT.md` §3 and
`.catalyst-proj/plugins/README.md`: manage the lifecycle of plugins in
this project. No plugin may be sourced from this project or from the
catalyst framework repository itself — every plugin has its own
repository, and installing/updating one pulls directly from there.
Plugins are never loaded into memory unless explicitly activated. Every
subcommand resolves plugin identity, repository URL, and version
information exclusively from the `catalog.md` registry of the
relevant plugin type (e.g. `.catalyst-proj/plugins/repository/catalog.md`)
— the sole source of truth for which plugins are registered. A plugin
name with no matching entry in the registry is unregistered; refuse any
subcommand invoked against it and report that it isn't registered. Each
catalog entry has a `Compatibility` field: a bare `*` means the plugin is
compatible with every framework version — the default for a registered
plugin — while a specific version or range excludes named framework
versions.

1. Resolve `$0` (the subcommand):
   - `list` — read `.catalyst-proj/plugins/plugins.md` and every plugin
     type's `catalog.md` (currently only
     `.catalyst-proj/plugins/repository/catalog.md`), and return the
     available plugins grouped by type, each with its registered
     repository URL, pinned release/tag, and compatibility. If none are
     installed, say so.
   - `activate <name> <version|latest>` — look up `<name>` in the
     registry to resolve its repository URL. A version argument is
     required. If the plugin isn't already present under
     `.catalyst-proj/plugins/<type>/<name>/`, download it from that
     repository at the requested version (resolving `latest` to the
     newest available tag from the plugin's own repository, not the
     registry's pinned tag), then load it into memory. Refuse activation
     unless the plugin's root directory contains both a `README.md` and a
     `working-contract.md` file — report the missing requirement instead.
     If a plugin with the same name is already loaded, replace it in
     memory with the new instance. Record `active: true` in its metadata.
   - `download <name> <version|latest>` — resolve `<name>` against the
     registry the same way, then download the plugin without
     activating it; it stays installed and inactive until explicitly
     activated later.
   - `deactivate <name>` — leave the plugin installed but mark its
     `active` metadata flag false and flush it from memory.
   - `upgrade <name|latest>` — resolve the plugin's repository URL from
     the registry, then update an already-installed plugin to the
     requested version or to the latest available version.
   - `downgrade <name> <version>` — resolve the plugin's repository URL
     from the registry, then downgrade an already-installed plugin
     to the specified version.
   If `$0` doesn't match one of these subcommands, state that it's
   unsupported and list the valid subcommands.
2. Every plugin must declare at minimum: `name`, `description`, `uuid`,
   `version`, `active`, and `type`. On framework startup, only plugins
   whose `active` flag is true are scanned and activated — this is a hard
   rule and must not be bypassed.
3. Report the resulting state (installed/activated/deactivated/version)
   after any change, and update
   `.catalyst-proj/plugins/plugins.md`/`repository/catalog.md`
   accordingly.
