# Test-only images for the disposable egress check. Neither is a production
# runtime; #25 stays disabled.
ARG BASE_IMAGE
ARG DEPS_IMAGE

FROM ${DEPS_IMAGE} AS deps

# App image plus the lockfile's node_modules, so the checkout's real tool
# sources load with Node's type stripping. The standalone app bundles them.
FROM ${BASE_IMAGE} AS tools
COPY --from=deps /workspace/node_modules /workspace/node_modules
USER 1000:1000
ENTRYPOINT []

# App image plus Chromium, so a real browser runs in its own guard namespace.
FROM ${BASE_IMAGE} AS browser
USER 0:0
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
ENTRYPOINT []
