# syntax=docker/dockerfile:1

# Wraps log-sump's own generic image with this repo's plugins mounted in
# via its own generic plugin-loading mechanism (log_sump.server.plugins) --
# log-sump's own Dockerfile/image (app/server-logsump/docker/Dockerfile)
# has no knowledge this directory exists, and never should: what plugins a
# particular deployment needs is entirely this repo's concern, layered on
# afterward, not baked into log-sump itself. See legacy_gateway_api/
# __init__.py for what the one plugin here actually does.
#
# LOG_SUMP_IMAGE is the tag releases/_shared/build-image.sh already built
# from app/server-logsump/docker/Dockerfile -- this is a second, separate
# `docker build` layered on top of it, not a multi-stage build of the same
# Dockerfile, so log-sump's own build stays completely independent and
# buildable on its own.
ARG LOG_SUMP_IMAGE
FROM ${LOG_SUMP_IMAGE}

COPY legacy_gateway_api /opt/cttc-plugins/legacy_gateway_api
