"""HTTP routes for the legacy gateway API plugin -- see this package's
`__init__.py` for what this is and why it exists as a log-sump plugin.
Source lifecycle: `GET /sources`, `GET /range`, `POST /docker/collect`,
`POST /docker/forget`, `POST /docker/ps`, `POST /close`. Chart/log-panel
queries (once a source from that first group is already open): `GET
/logs`, `GET /stats_export`, and, under `/legacy/*` (see below), `GET
/point`, `GET /series`, `GET /index_at`, `GET /ticks`, `GET /logs/find`.
Every request/response shape here matches the legacy gateway's own wire
protocol exactly (field names, `docker://<host>/<type>/<name>` source
ids, millisecond-epoch-number timestamps, not log-sump's own ISO
datetimes elsewhere) so its existing client can keep talking to this
backend essentially unchanged.

The `/legacy/*` prefix on five of these (not all -- `/sources` etc. and
`/logs`/`/stats_export` have no built-in counterpart to collide with) is
not a stylistic choice: log-sump's own built-in `series` router already
owns bare `/point`, `/series`, `/index_at`, `/ticks`, `/logs/find` for its
own, differently-addressed (`docker_host`+`container_id`, `X-API-Key`)
native API -- confirmed the hard way that mounting this plugin's own
versions at those same bare paths made the built-in ones unreachable
(app.py's plugin-mounting loop now rejects that outright, see its own
comment) rather than actually working around them. This client's own
renderer call sites for these five (only these five) point at `/legacy/*`
accordingly.

Gated by the gateway token, matching what the legacy client actually sends
(`X-CTTC-Token`) -- the same gate log-sump's own `routers/gateway.py` uses;
not the daemon-scoped `X-API-Key` model `/daemons`/`/records`/etc. use,
which this client has no knowledge of at all.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from redis.asyncio import Redis

from log_sump.server.deps import get_redis, require_gateway_token

from . import compat

router = APIRouter(dependencies=[Depends(require_gateway_token)])


def _from_ms(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000.0, tz=UTC)


class SourcesResponse(BaseModel):
    sources: list[dict[str, Any]]
    json_impl: str = "log-sump-legacy-gateway-api"


@router.get("/sources")
async def get_sources(redis: Annotated[Redis, Depends(get_redis)]) -> SourcesResponse:
    return SourcesResponse(sources=await compat.list_sources(redis))


class RangeResponse(BaseModel):
    min_ts: int | None
    max_ts: int | None


@router.get("/range")
async def get_range(redis: Annotated[Redis, Depends(get_redis)]) -> RangeResponse:
    lo, hi = await compat.time_range(redis)
    return RangeResponse(min_ts=lo, max_ts=hi)


class DockerPsRequest(BaseModel):
    host: str | None = None
    ssh_key: str | None = None


@router.post("/docker/ps")
async def post_docker_ps(
    body: DockerPsRequest, redis: Annotated[Redis, Depends(get_redis)]
) -> dict[str, Any]:
    return await compat.preview_containers(redis, body.host)


class LogTarget(BaseModel):
    name: str
    type: str = "container"


class DockerCollectRequest(BaseModel):
    host: str | None = None
    ssh_key: str | None = None
    stats: bool = True
    host_stats: bool = True
    logs: list[LogTarget] = []
    transforms: list[str] = []
    interval: float = 5.0


class DockerCollectResponse(BaseModel):
    opened: list[str]
    sources: list[dict[str, Any]]


@router.post("/docker/collect")
async def post_docker_collect(
    body: DockerCollectRequest, redis: Annotated[Redis, Depends(get_redis)]
) -> DockerCollectResponse:
    _daemon, opened_ids = await compat.collect(
        redis,
        host=body.host,
        stats=body.stats,
        host_stats=body.host_stats,
        logs=[t.model_dump() for t in body.logs],
    )
    return DockerCollectResponse(opened=opened_ids, sources=await compat.list_sources(redis))


class DockerForgetRequest(BaseModel):
    host: str | None = None


class OkResponse(BaseModel):
    ok: bool = True


@router.post("/docker/forget")
async def post_docker_forget(
    body: DockerForgetRequest, redis: Annotated[Redis, Depends(get_redis)]
) -> OkResponse:
    await compat.forget_daemon(redis, body.host)
    return OkResponse()


class CloseRequest(BaseModel):
    id: str


@router.post("/close")
async def post_close(body: CloseRequest, redis: Annotated[Redis, Depends(get_redis)]) -> OkResponse:
    await compat.close_source(redis, body.id)
    return OkResponse()


# ── chart/log-panel queries ─────────────────────────────────────────────────


class PointResponse(BaseModel):
    t: float
    services: dict[str, Any]


@router.get("/legacy/point")
async def get_point(redis: Annotated[Redis, Depends(get_redis)], t: float) -> PointResponse:
    services = await compat.point_all(redis, _from_ms(t))
    return PointResponse(t=t, services=services)


class SeriesResponse(BaseModel):
    model_config = {"populate_by_name": True}

    from_: float = Field(alias="from")
    to: float
    px: int
    services: list[dict[str, Any]]


@router.get("/legacy/series")
async def get_series(
    redis: Annotated[Redis, Depends(get_redis)],
    from_: Annotated[float, Query(alias="from")],
    to: float,
    px: int = 800,
) -> SeriesResponse:
    services = await compat.series_all(redis, _from_ms(from_), _from_ms(to), px)
    return SeriesResponse(from_=from_, to=to, px=px, services=services)


class StatsExportResponse(BaseModel):
    model_config = {"populate_by_name": True}

    from_: float = Field(alias="from")
    to: float
    granularity: str
    services: list[dict[str, Any]]


@router.get("/stats_export")
async def get_stats_export(
    redis: Annotated[Redis, Depends(get_redis)],
    from_: Annotated[float, Query(alias="from")],
    to: float,
    granularity: Annotated[str, Query(pattern="^(summary|full)$")] = "summary",
) -> StatsExportResponse:
    services = await compat.stats_export_all(redis, int(from_), int(to), granularity)
    return StatsExportResponse(from_=from_, to=to, granularity=granularity, services=services)


class LogsResponse(BaseModel):
    total: int
    rows: list[dict[str, Any]]


@router.get("/logs")
async def get_logs(
    redis: Annotated[Redis, Depends(get_redis)], source: str, start: int = 0, count: int = 200
) -> LogsResponse:
    try:
        total, rows = await compat.logs_page(redis, source, start, min(count, 2000))
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    return LogsResponse(total=total, rows=rows)


class IndexAtResponse(BaseModel):
    index: int


@router.get("/legacy/index_at")
async def get_index_at(
    redis: Annotated[Redis, Depends(get_redis)], source: str, t: float
) -> IndexAtResponse:
    try:
        index = await compat.logs_index_at(redis, source, int(t))
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    return IndexAtResponse(index=index)


class TicksResponse(BaseModel):
    counts: list[int]


@router.get("/legacy/ticks")
async def get_ticks(
    redis: Annotated[Redis, Depends(get_redis)],
    source: str,
    from_: Annotated[float, Query(alias="from")],
    to: float,
    px: int = 800,
) -> TicksResponse:
    try:
        counts = await compat.logs_ticks(redis, source, int(from_), int(to), px)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    return TicksResponse(counts=counts)


class FindResponse(BaseModel):
    index: int | None


@router.get("/legacy/logs/find")
async def get_logs_find(
    redis: Annotated[Redis, Depends(get_redis)],
    source: str,
    q: str,
    start: int = 0,
    dir: Annotated[str, Query(pattern="^(fwd|back)$")] = "fwd",
) -> FindResponse:
    try:
        index = await compat.logs_find(redis, source, q, start, dir != "back")
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    return FindResponse(index=index)
