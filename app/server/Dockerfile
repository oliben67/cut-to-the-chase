# syntax=docker/dockerfile:1
#
# Runs the CTTC server as a standalone container on a Docker-enabled host,
# for clients that can't have Docker installed locally (see
# docs/architecture/remote-server.md). Build/run with docker-compose.yml in
# this directory, which sets the pid/network host modes and socket mount
# this image needs to see the *host's* containers and vitals correctly.
#
# Multi-stage on alpine: curl, the docker CLI tarball, and uv's own install
# footprint are only needed to *produce* the venv and fetch the docker binary
# -- none of that belongs in the shipped image, so it all stays in `builder`.
# alpine (musl) over slim (glibc) roughly halves the base image; every
# dependency here (orjson, psutil, docker, fastapi, uvicorn[standard] and
# its uvloop/httptools/watchfiles/websockets extras) ships musllinux wheels,
# so no compiler is needed either.
FROM python:3.14-alpine AS builder

ARG DOCKER_CLI_VERSION=27.3.1
ARG TARGETARCH
RUN apk add --no-cache curl \
    && arch="$(case "$TARGETARCH" in amd64) echo x86_64 ;; arm64) echo aarch64 ;; *) echo "$TARGETARCH" ;; esac)" \
    && curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
       | tar -xz --strip-components=1 -C /usr/local/bin docker/docker \
    && docker --version

RUN pip install --no-cache-dir uv

WORKDIR /srv/cttc-gateway
# dependency layer first so `uv sync` is only re-run when pyproject.toml
# actually changes, not on every server.py edit
COPY pyproject.toml ./
# uv treats the "dev" group as included by default -- --no-dev keeps
# pytest/pytest-cov/coverage out of the deployed image
RUN uv sync --no-dev
COPY server.py files.py ./
COPY transforms ./transforms

FROM python:3.14-alpine

# docker CLI only (not the full engine -- this container never runs its own
# dockerd; listing containers/services and one-shot stats snapshots go
# through the `docker` Python SDK instead, talking to the host's daemon
# directly over the mounted socket -- the CLI binary is only still needed
# for DockerLogSource's `docker logs -f`/`docker service logs -f`, which
# uses an asyncio subprocess rather than the SDK on purpose: see server.py)
# + openssh-client (HostStatsSource can sample a *different* host over ssh,
# independent of what this container itself runs on).
RUN apk add --no-cache ca-certificates openssh-client
COPY --from=builder /usr/local/bin/docker /usr/local/bin/docker

# `docker -H ssh://...` (Set Sources with an ssh:// host, e.g. to reach a
# *third* machine from this container) execs plain ssh with no flags of its
# own, so without this it either hangs on an interactive host-key prompt (no
# tty, no stdin -- capture_output=True in server.py) or fails outright on
# first contact with a host. accept-new is TOFU-on-first-connection, same
# trust model most people already accept from an interactive `ssh` the first
# time; it still detects a *changed* key later, unlike StrictHostKeyChecking
# no/UserKnownHostsFile=/dev/null. Container filesystem is ephemeral, so this
# effectively re-TOFUs every container restart -- acceptable since restarts
# are an operator action, not something reachable by whatever's on the other
# end of the ssh connection.
RUN mkdir -p /etc/ssh/ssh_config.d && printf 'Host *\n  StrictHostKeyChecking accept-new\n' \
    > /etc/ssh/ssh_config.d/99-cttc-accept-new.conf

WORKDIR /srv/cttc-gateway
COPY --from=builder /srv/cttc-gateway ./
# uv itself (the dependency manager) never needs to run in the final image --
# it only ever produced the venv in the builder stage, so the final image
# just execs the venv's own python interpreter directly.
ENV PATH="/srv/cttc-gateway/.venv/bin:${PATH}"

EXPOSE 8765
# 0.0.0.0: the client talks to this container directly over plain HTTP (no
# ssh tunnel -- see docs/architecture/remote-server.md), so it must be
# reachable on the host's real network interfaces, not just loopback.
# --network=host (see docker-compose.yml) means this *is* the host's own
# network stack, so binding 0.0.0.0 here exposes it exactly as if the port
# were opened directly on the host.
ENTRYPOINT ["python", "server.py", "--host", "0.0.0.0", "--port", "8765"]
