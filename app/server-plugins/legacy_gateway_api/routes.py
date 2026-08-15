"""HTTP routes for the legacy gateway API plugin -- see this package's
`__init__.py` for what this is and why it exists as a log-sump plugin.
Source lifecycle: `GET /sources`, `GET /range`, `POST /docker/collect`,
`POST /docker/forget`, `POST /docker/ps`, `POST /close`. Chart/log-panel
queries (once a source from that first group is already open): `GET
/logs`, `GET /stats_export`, and, under `/legacy/*` (see below), `GET
/point`, `GET /series`, `GET /index_at`, `GET /ticks`, `GET /logs/find`.
Recording sessions, also under `/legacy/*`: `POST /session/start`,
`/{id}/stop`, `/{id}/safe`, `GET /{id}/status`, `/{id}/download`, `POST
/session/ttl`. Gateway-hosted events, also under `/legacy/*`: `POST
/events/create`, `GET /events/list`, `GET /events/{id}`, `POST
/events/{id}/update`, `/enable`, `/disable`, `/reset`, `/cancel`. Every
request/response shape here matches the legacy gateway's own wire
protocol exactly (field names, `docker://<host>/<type>/<name>` source
ids, millisecond-epoch-number timestamps, not log-sump's own ISO
datetimes elsewhere) so its existing client can keep talking to this
backend essentially unchanged.

The `/legacy/*` prefix on most of these (not all -- `/sources` etc. and
`/logs`/`/stats_export` have no built-in counterpart to collide with) is
not a stylistic choice: log-sump's own built-in `series`, `sessions`,
and `events` routers already own bare `/point`, `/series`, `/index_at`,
`/ticks`, `/logs/find`, the whole `/session/*` family, and the whole
`/events/*` family, for their own, differently-addressed
(`docker_host`(+`container_id`), `X-API-Key`) native APIs -- confirmed
the hard way that mounting this plugin's own versions at those same bare
paths made the built-in ones unreachable (app.py's plugin-mounting loop
now rejects that outright, see its own comment) rather than actually
working around them. This client's own renderer call sites for these
point at `/legacy/*` accordingly.

Gated by the gateway token, matching what the legacy client actually sends
(`X-CTTC-Token`) -- the same gate log-sump's own `routers/gateway.py` uses;
not the daemon-scoped `X-API-Key` model `/daemons`/`/records`/etc. use,
which this client has no knowledge of at all.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from redis.asyncio import Redis

from log_sump.server.deps import get_redis, require_gateway_token

from . import compat, events_compat, sessions_compat

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


# ── recording sessions ──────────────────────────────────────────────────────


class SessionStartRequest(BaseModel):
    duration_minutes: float | None = None
    safe: bool = False
    max_keep_seconds: float | None = None


class SessionStartResponse(BaseModel):
    session_id: str


@router.post("/legacy/session/start")
async def post_session_start(
    body: SessionStartRequest, redis: Annotated[Redis, Depends(get_redis)]
) -> SessionStartResponse:
    session_id = await sessions_compat.start(
        redis,
        duration_minutes=body.duration_minutes,
        safe=body.safe,
        max_keep_seconds=body.max_keep_seconds,
    )
    return SessionStartResponse(session_id=session_id)


@router.post("/legacy/session/{session_id}/stop")
async def post_session_stop(
    session_id: str, redis: Annotated[Redis, Depends(get_redis)]
) -> OkResponse:
    try:
        await sessions_compat.stop(redis, session_id)
    except sessions_compat.UnknownSession as exc:
        raise HTTPException(404, detail=f"unknown session: {session_id}") from exc
    return OkResponse()


class SessionSafeRequest(BaseModel):
    max_keep_seconds: float


@router.post("/legacy/session/{session_id}/safe")
async def post_session_safe(session_id: str, body: SessionSafeRequest) -> OkResponse:
    try:
        sessions_compat.mark_safe(session_id, body.max_keep_seconds)
    except sessions_compat.UnknownSession as exc:
        raise HTTPException(404, detail=f"unknown session: {session_id}") from exc
    return OkResponse()


@router.get("/legacy/session/{session_id}/status")
async def get_session_status(
    session_id: str, redis: Annotated[Redis, Depends(get_redis)]
) -> dict[str, Any]:
    try:
        return await sessions_compat.status_of(redis, session_id)
    except sessions_compat.UnknownSession as exc:
        raise HTTPException(404, detail=f"unknown session: {session_id}") from exc


@router.get("/legacy/session/{session_id}/download")
async def get_session_download(session_id: str) -> Response:
    try:
        data, ext = sessions_compat.download(session_id)
    except sessions_compat.UnknownSession as exc:
        raise HTTPException(
            404, detail=f"unknown or not-yet-completed session: {session_id}"
        ) from exc
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{session_id}{ext}"',
            "Access-Control-Allow-Origin": "*",
        },
    )


class SessionTtlRequest(BaseModel):
    seconds: float


@router.post("/legacy/session/ttl")
async def post_session_ttl(body: SessionTtlRequest) -> OkResponse:
    sessions_compat.set_default_ttl(body.seconds)
    return OkResponse()


# ── gateway-hosted events ────────────────────────────────────────────────────


class EventCreateRequest(BaseModel):
    name: str = ""
    source_ids: list[str] = []
    conditions: list[dict[str, Any]] = []
    action: dict[str, Any] = {}
    match: Literal["any", "all"] = "any"


class EventIdResponse(BaseModel):
    event_id: str


@router.post("/legacy/events/create")
async def post_events_create(
    body: EventCreateRequest, redis: Annotated[Redis, Depends(get_redis)]
) -> EventIdResponse:
    try:
        conditions = [events_compat.parse_condition(c) for c in body.conditions]
        action = events_compat.parse_action(body.action)
        event_id = await events_compat.create(
            redis,
            name=body.name,
            source_ids=set(body.source_ids),
            conditions=conditions,
            action=action,
            match=body.match,
        )
    except events_compat.InvalidEvent as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    return EventIdResponse(event_id=event_id)


class EventListResponse(BaseModel):
    event_ids: list[str]


@router.get("/legacy/events/list")
async def get_events_list() -> EventListResponse:
    return EventListResponse(event_ids=events_compat.list_ids())


@router.get("/legacy/events/{event_id}")
async def get_event_status(
    event_id: str, redis: Annotated[Redis, Depends(get_redis)]
) -> dict[str, Any]:
    try:
        return await events_compat.status_of(redis, event_id)
    except events_compat.UnknownEvent as exc:
        raise HTTPException(404, detail=f"unknown event: {event_id}") from exc


@router.post("/legacy/events/{event_id}/enable")
async def post_event_enable(event_id: str) -> OkResponse:
    try:
        events_compat.enable(event_id)
    except events_compat.UnknownEvent as exc:
        raise HTTPException(404, detail=f"unknown event: {event_id}") from exc
    return OkResponse()


@router.post("/legacy/events/{event_id}/disable")
async def post_event_disable(event_id: str) -> OkResponse:
    try:
        events_compat.disable(event_id)
    except events_compat.UnknownEvent as exc:
        raise HTTPException(404, detail=f"unknown event: {event_id}") from exc
    return OkResponse()


@router.post("/legacy/events/{event_id}/reset")
async def post_event_reset(event_id: str) -> OkResponse:
    try:
        events_compat.reset(event_id)
    except events_compat.UnknownEvent as exc:
        raise HTTPException(404, detail=f"unknown event: {event_id}") from exc
    return OkResponse()


class EventUpdateRequest(BaseModel):
    name: str | None = None
    source_ids: list[str] | None = None
    conditions: list[dict[str, Any]] | None = None
    action: dict[str, Any] | None = None
    match: Literal["any", "all"] | None = None


@router.post("/legacy/events/{event_id}/update")
async def post_event_update(
    event_id: str, body: EventUpdateRequest, redis: Annotated[Redis, Depends(get_redis)]
) -> OkResponse:
    try:
        conditions = (
            [events_compat.parse_condition(c) for c in body.conditions]
            if body.conditions is not None
            else None
        )
        action = events_compat.parse_action(body.action) if body.action is not None else None
        await events_compat.update(
            redis,
            event_id,
            name=body.name,
            source_ids=set(body.source_ids) if body.source_ids is not None else None,
            conditions=conditions,
            action=action,
            match=body.match,
        )
    except events_compat.UnknownEvent as exc:
        raise HTTPException(404, detail=f"unknown event: {event_id}") from exc
    except events_compat.InvalidEvent as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    return OkResponse()


@router.post("/legacy/events/{event_id}/cancel")
async def post_event_cancel(event_id: str) -> OkResponse:
    try:
        events_compat.cancel(event_id)
    except events_compat.UnknownEvent as exc:
        raise HTTPException(404, detail=f"unknown event: {event_id}") from exc
    return OkResponse()
