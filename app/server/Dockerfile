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
# alpine (musl) over slim (glibc) roughly halves the base image; cryptography,
# orjson and psutil all ship musllinux wheels so no compiler is needed here.
FROM python:3.12-alpine AS builder

ARG DOCKER_CLI_VERSION=27.3.1
ARG TARGETARCH
RUN apk add --no-cache curl \
    && arch="$(case "$TARGETARCH" in amd64) echo x86_64 ;; arm64) echo aarch64 ;; *) echo "$TARGETARCH" ;; esac)" \
    && curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
       | tar -xz --strip-components=1 -C /usr/local/bin docker/docker \
    && docker --version

RUN pip install --no-cache-dir uv

WORKDIR /srv/cttc-server
# dependency layer first so `uv sync` is only re-run when pyproject.toml
# actually changes, not on every server.py edit
COPY pyproject.toml ./
# uv treats the "dev" group as included by default -- --no-dev keeps
# pytest/pytest-cov/coverage out of the deployed image
RUN uv sync --no-dev
COPY server.py files.py ./
COPY transforms ./transforms

FROM python:3.12-alpine

# docker CLI only (not the full engine -- this container never runs its own
# dockerd, it talks to the host's daemon over the mounted socket) +
# openssh-client (HostStatsSource can sample a *different* host over ssh,
# independent of what this container itself runs on).
RUN apk add --no-cache ca-certificates openssh-client
COPY --from=builder /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /srv/cttc-server
COPY --from=builder /srv/cttc-server ./
# uv itself (the dependency manager) never needs to run in the final image --
# it only ever produced the venv in the builder stage, so the final image
# just execs the venv's own python interpreter directly.
ENV PATH="/srv/cttc-server/.venv/bin:${PATH}"

EXPOSE 8765
# server.py hardcodes a 127.0.0.1 bind by design (docs/architecture/
# remote-server.md's whole point: no code change needed here). With
# --network=host (see docker-compose.yml) that loopback *is* the host's
# loopback, so the host's ssh tunnel can reach it exactly as if this were
# a same-machine embedded server.
ENTRYPOINT ["python", "server.py", "--port", "8765"]
