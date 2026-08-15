"""HTTP-level tests for the legacy gateway API plugin's routes, mounted
into a real log-sump app via the plugin mechanism (not imported directly)
so these tests also double as end-to-end confirmation that the plugin
loads and mounts correctly.
"""

import sys
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fakeredis import FakeAsyncRedis
from httpx import ASGITransport, AsyncClient

from log_sump.common.config import GatewayConfig, PluginsConfig, Settings
from log_sump.common.redis_keys import stream_key
from log_sump.common.schema import Kind, LogRecord, MetricRecord, RecordAdapter
from log_sump.server.app import create_app

TOKEN = "gateway-secret"
PLUGINS_DIR = Path(__file__).resolve().parent.parent.parent


@pytest.fixture(autouse=True)
def _reload_plugin_fresh_every_test():
    """create_app()'s plugin loader (`log_sump.server.plugins`) registers
    the plugin package under a fixed `sys.modules` name and only
    overwrites *that* top-level entry on each load -- its submodules
    (`.routes`, `.compat`, `.log_index`) stay cached in `sys.modules` from
    whichever test loaded them first, since Python's own relative-import
    resolution reuses an already-registered submodule rather than
    re-executing it. Harmless in real deployments (`create_app()` runs
    once per process there), but `log_index.py`'s in-process rank cache is
    the first piece of this plugin's own state that isn't Redis-backed,
    so it's the first thing to actually leak between this file's own
    `create_app()` calls -- purge every submodule so each test's `client`
    fixture gets a genuinely fresh plugin load, matching what a real
    process restart would give it.
    """
    prefix = "log_sump_plugin_legacy_gateway_api"
    for mod_name in [n for n in sys.modules if n == prefix or n.startswith(prefix + ".")]:
        del sys.modules[mod_name]
    yield


@pytest.fixture
async def redis() -> AsyncIterator[FakeAsyncRedis]:
    yield FakeAsyncRedis()


@pytest.fixture
async def client(redis: FakeAsyncRedis) -> AsyncIterator[AsyncClient]:
    settings = Settings(
        gateway=GatewayConfig(token=TOKEN), plugins=PluginsConfig(directory=str(PLUGINS_DIR))
    )
    app = create_app(settings=settings, redis=redis)
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


def _auth_headers() -> dict[str, str]:
    return {"X-CTTC-Token": TOKEN}


async def test_sources_requires_gateway_token(client: AsyncClient) -> None:
    resp = await client.get("/sources")
    assert resp.status_code == 401


async def test_sources_empty_initially(client: AsyncClient) -> None:
    resp = await client.get("/sources", headers=_auth_headers())
    assert resp.status_code == 200
    assert resp.json() == {"sources": [], "json_impl": "log-sump-legacy-gateway-api"}


async def test_range_empty_initially(client: AsyncClient) -> None:
    resp = await client.get("/range", headers=_auth_headers())
    assert resp.status_code == 200
    assert resp.json() == {"min_ts": None, "max_ts": None}


async def test_docker_collect_then_sources_reflects_it(client: AsyncClient) -> None:
    resp = await client.post(
        "/docker/collect",
        json={"host": None, "stats": True, "host_stats": True, "logs": [{"name": "web"}]},
        headers=_auth_headers(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "docker://local/host" in body["opened"]
    assert "docker://local/container/web" in body["opened"]

    sources_resp = await client.get("/sources", headers=_auth_headers())
    ids = {s["id"] for s in sources_resp.json()["sources"]}
    assert "docker://local/host" in ids
    assert "docker://local/container/web" in ids


async def test_docker_forget_removes_the_daemon(client: AsyncClient) -> None:
    await client.post(
        "/docker/collect",
        json={"host": None, "stats": False, "host_stats": True, "logs": []},
        headers=_auth_headers(),
    )

    resp = await client.post("/docker/forget", json={"host": None}, headers=_auth_headers())

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    sources_resp = await client.get("/sources", headers=_auth_headers())
    assert sources_resp.json()["sources"] == []


async def test_close_removes_one_log_source(client: AsyncClient) -> None:
    await client.post(
        "/docker/collect",
        json={
            "host": None,
            "stats": False,
            "host_stats": False,
            "logs": [{"name": "web"}, {"name": "db"}],
        },
        headers=_auth_headers(),
    )

    resp = await client.post(
        "/close", json={"id": "docker://local/container/web"}, headers=_auth_headers()
    )

    assert resp.status_code == 200
    sources_resp = await client.get("/sources", headers=_auth_headers())
    names = {s["name"] for s in sources_resp.json()["sources"] if s["kind"] == "log"}
    assert names == {"db"}


async def test_docker_ps_preview(client: AsyncClient, redis: FakeAsyncRedis) -> None:
    resp = await client.post("/docker/ps", json={"host": None}, headers=_auth_headers())
    assert resp.status_code == 200
    body = resp.json()
    assert "containers" in body
    assert "services" in body


async def _seed_log_via_redis(
    redis: FakeAsyncRedis, container_name: str, ts_ms: int, text: str
) -> None:
    record = LogRecord(
        docker_host="local",
        container_name=container_name,
        container_id=f"{container_name}-id",
        ts=datetime.fromtimestamp(ts_ms / 1000.0, tz=UTC),
        seq=1,
        stream="stdout",
        level="info",
        message=text,
        raw=text,
    )
    await redis.xadd(
        stream_key("local", Kind.LOG),
        {"data": RecordAdapter.dump_json(record)},
        id=f"{ts_ms}-0",
    )


async def test_logs_returns_total_and_rows(client: AsyncClient, redis: FakeAsyncRedis) -> None:
    await client.post(
        "/docker/collect",
        json={"host": None, "stats": False, "host_stats": False, "logs": [{"name": "web"}]},
        headers=_auth_headers(),
    )
    await _seed_log_via_redis(redis, "web", 1000, "hello")
    await _seed_log_via_redis(redis, "web", 1001, "world")

    resp = await client.get(
        "/logs",
        params={"source": "docker://local/container/web", "start": 0, "count": 10},
        headers=_auth_headers(),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert [r["text"] for r in body["rows"]] == ["hello", "world"]


async def test_logs_unknown_source_is_a_bad_request(client: AsyncClient) -> None:
    resp = await client.get(
        "/logs", params={"source": "docker://local/stats"}, headers=_auth_headers()
    )
    assert resp.status_code == 400


async def test_legacy_index_at_and_ticks_and_find(
    client: AsyncClient, redis: FakeAsyncRedis
) -> None:
    await client.post(
        "/docker/collect",
        json={"host": None, "stats": False, "host_stats": False, "logs": [{"name": "web"}]},
        headers=_auth_headers(),
    )
    await _seed_log_via_redis(redis, "web", 1000, "alpha")
    await _seed_log_via_redis(redis, "web", 2000, "beta")
    sid = "docker://local/container/web"

    index_resp = await client.get(
        "/legacy/index_at", params={"source": sid, "t": 1000}, headers=_auth_headers()
    )
    assert index_resp.json() == {"index": 0}

    ticks_resp = await client.get(
        "/legacy/ticks",
        params={"source": sid, "from": 1000, "to": 2001, "px": 2},
        headers=_auth_headers(),
    )
    assert ticks_resp.json() == {"counts": [1, 1]}

    find_resp = await client.get(
        "/legacy/logs/find",
        params={"source": sid, "q": "beta", "start": 0, "dir": "fwd"},
        headers=_auth_headers(),
    )
    assert find_resp.json() == {"index": 1}


async def test_legacy_point_and_series(client: AsyncClient, redis: FakeAsyncRedis) -> None:
    await client.post(
        "/docker/collect",
        json={"host": None, "stats": True, "host_stats": True, "logs": [{"name": "web"}]},
        headers=_auth_headers(),
    )
    record = MetricRecord(
        docker_host="local",
        container_name="web",
        container_id="web-id",
        ts=datetime.fromtimestamp(1.0, tz=UTC),
        seq=1,
        metric_scope="container",
        cpu_pct=42.0,
        mem_pct=10.0,
        source="docker stats",
    )
    await redis.xadd(
        stream_key("local", Kind.METRIC),
        {"data": RecordAdapter.dump_json(record)},
        id="1000-0",
    )

    point_resp = await client.get(
        "/legacy/point", params={"t": 1000}, headers=_auth_headers()
    )
    assert point_resp.json()["services"]["web"]["cpu"] == 42.0

    series_resp = await client.get(
        "/legacy/series", params={"from": 0, "to": 5000, "px": 4}, headers=_auth_headers()
    )
    body = series_resp.json()
    assert body["from"] == 0
    names = {s["name"] for s in body["services"]}
    assert "web" in names


async def test_stats_export(client: AsyncClient, redis: FakeAsyncRedis) -> None:
    await client.post(
        "/docker/collect",
        json={"host": None, "stats": True, "host_stats": False, "logs": [{"name": "web"}]},
        headers=_auth_headers(),
    )
    record = MetricRecord(
        docker_host="local",
        container_name="web",
        container_id="web-id",
        ts=datetime.fromtimestamp(1.0, tz=UTC),
        seq=1,
        metric_scope="container",
        cpu_pct=42.0,
        mem_pct=10.0,
        source="docker stats",
    )
    await redis.xadd(
        stream_key("local", Kind.METRIC),
        {"data": RecordAdapter.dump_json(record)},
        id="1000-0",
    )

    resp = await client.get(
        "/stats_export",
        params={"from": 0, "to": 5000, "granularity": "summary"},
        headers=_auth_headers(),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["granularity"] == "summary"
    web = next(s for s in body["services"] if s["name"] == "web")
    assert web["cpu"] == {"min": 42.0, "avg": 42.0, "max": 42.0}


async def test_session_start_stop_status_download(
    client: AsyncClient, redis: FakeAsyncRedis
) -> None:
    await client.post(
        "/docker/collect",
        json={"host": None, "stats": False, "host_stats": False, "logs": [{"name": "web"}]},
        headers=_auth_headers(),
    )

    start_resp = await client.post(
        "/legacy/session/start", json={}, headers=_auth_headers()
    )
    assert start_resp.status_code == 200
    session_id = start_resp.json()["session_id"]

    await _seed_log_via_redis(redis, "web", 1000, "hello from session")

    status_resp = await client.get(
        f"/legacy/session/{session_id}/status", headers=_auth_headers()
    )
    assert status_resp.json() == {
        "session_id": session_id,
        "status": "running",
        "ready": False,
        "safe": False,
    }

    stop_resp = await client.post(
        f"/legacy/session/{session_id}/stop", headers=_auth_headers()
    )
    assert stop_resp.status_code == 200

    status_resp = await client.get(
        f"/legacy/session/{session_id}/status", headers=_auth_headers()
    )
    assert status_resp.json()["status"] == "completed"
    assert status_resp.json()["ready"] is True

    download_resp = await client.get(
        f"/legacy/session/{session_id}/download", headers=_auth_headers()
    )
    assert download_resp.status_code == 200
    assert f'{session_id}.cttc-record' in download_resp.headers["content-disposition"]


async def test_session_status_of_unknown_session_is_404(client: AsyncClient) -> None:
    resp = await client.get("/legacy/session/leg-rec999/status", headers=_auth_headers())
    assert resp.status_code == 404


async def test_session_safe_and_ttl(client: AsyncClient) -> None:
    start_resp = await client.post("/legacy/session/start", json={}, headers=_auth_headers())
    session_id = start_resp.json()["session_id"]

    safe_resp = await client.post(
        f"/legacy/session/{session_id}/safe",
        json={"max_keep_seconds": 999.0},
        headers=_auth_headers(),
    )
    assert safe_resp.status_code == 200

    ttl_resp = await client.post(
        "/legacy/session/ttl", json={"seconds": 3600.0}, headers=_auth_headers()
    )
    assert ttl_resp.status_code == 200
    assert ttl_resp.json() == {"ok": True}


async def test_bare_session_start_is_still_the_built_in_route(client: AsyncClient) -> None:
    """Confirms /legacy/session/* didn't just add a working path -- the
    built-in daemon-scoped /session/start (X-API-Key, not the gateway
    token) must still be the one answering at the bare path, per
    br-PLUG-001.
    """
    resp = await client.post(
        "/session/start", json={"docker_host": "local"}, headers=_auth_headers()
    )
    assert resp.status_code == 401  # missing X-API-Key -- proves the built-in handler answered
