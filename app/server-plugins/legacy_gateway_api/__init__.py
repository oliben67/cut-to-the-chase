"""log-sump plugin: reproduces cttc's own pre-log-sump gateway (app/server/
server.py)'s source-lifecycle wire protocol on top of log-sump's daemon/
stream model, so cttc's existing renderer (`app.js`) can keep talking to a
log-sump-backed gateway essentially unchanged.

Why this is a plugin, not part of log-sump itself: log-sump is a general
async log/metric collection backend with no knowledge of any particular
client. This translation only ever matters to *this one* client's
now-superseded wire protocol -- cttc's renderer's own source-id scheme
(`docker://<host>/<type>/<name>`), its `/docker/collect`-style ceremony
for picking specific containers to watch, its millisecond-epoch-number
timestamps. None of that is a capability log-sump itself should carry
permanently; it belongs entirely to this one client's own migration path
off its old backend. See `routes.py`'s own module docstring for the exact
route list, including why five of them are mounted under `/legacy/*`
rather than at the bare path the old gateway itself used.

Deployed by mounting this directory (or a directory containing it,
alongside any sibling plugins) and pointing `LOG_SUMP_PLUGINS__DIRECTORY`
at it -- see log-sump's own `log_sump.server.plugins` module for the
loading mechanism, and cttc's `releases/_shared`/`releases/_repo`
docker-compose files for how this specific plugin gets mounted into cttc's
own gateway image.
"""

from __future__ import annotations

from .routes import router

__all__ = ["router"]
