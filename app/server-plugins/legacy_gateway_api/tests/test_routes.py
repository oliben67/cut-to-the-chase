"""HTTP-level tests for the legacy gateway API plugin's routes, mounted
into a real log-sump app via the plugin mechanism (not imported directly)
so these tests also double as end-to-end confirmation that the plugin
loads and mounts correctly.
"""

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fakeredis import FakeAsyncRedis
from httpx import ASGITransport, AsyncClient

from log_sump.common.config import GatewayConfig, PluginsConfig, Settings
from log_sump.server.app import create_app

TOKEN = "gateway-secret"
PLUGINS_DIR = Path(__file__).resolve().parent.parent.parent


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
