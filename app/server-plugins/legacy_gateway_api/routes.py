"""HTTP routes for the legacy gateway API plugin -- see this package's
`__init__.py` for what this is and why it exists as a log-sump plugin.
`GET /sources`, `GET /range`, `POST /docker/collect`, `POST
/docker/forget`, `POST /docker/ps`, `POST /close`. Every request/response
shape here matches the legacy gateway's own wire protocol exactly (field
names, `docker://<host>/<type>/<name>` source ids, millisecond-epoch-number
timestamps, not log-sump's own ISO datetimes elsewhere) so its existing
client can keep talking to this backend essentially unchanged.

Deliberately out of this plugin's scope: `/series`, `/point`, `/logs`, and
friends -- chart/log-panel queries, which only matter once a source from
this slice is already open, and are a separate plugin addition.

Gated by the gateway token, matching what the legacy client actually sends
(`X-CTTC-Token`) -- the same gate log-sump's own `routers/gateway.py` uses;
not the daemon-scoped `X-API-Key` model `/daemons`/`/records`/etc. use,
which this client has no knowledge of at all.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from redis.asyncio import Redis

from log_sump.server.deps import get_redis, require_gateway_token

from . import compat

router = APIRouter(dependencies=[Depends(require_gateway_token)])


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
