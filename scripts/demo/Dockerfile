# Offline demo verification worker. Build from the repository root:
#   docker build -f scripts/demo/Dockerfile -t learnharness:demo .
# Same pinned base as the root Dockerfile. Chromium comes from Debian's
# bookworm security archive; the worker copies only its own files.
FROM node:26.13.0-bookworm@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium=156.0.8078.79-1~deb12u1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/learnharness-demo
COPY scripts/demo/*.mjs scripts/demo/
COPY src/core/demo-document-policy.ts src/core/
# The socket volume is initialised from this directory, owned by the
# unprivileged worker so only uid 1000 can reach the socket.
RUN mkdir -p /run/learnharness-demo \
    && chown 1000:1000 /run/learnharness-demo \
    && chmod 700 /run/learnharness-demo \
    && chmod -R a-w /opt/learnharness-demo
ENV NODE_ENV=production HOME=/tmp TMPDIR=/tmp
USER 1000:1000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "/opt/learnharness-demo/scripts/demo/healthcheck.mjs"]
ENTRYPOINT ["node", "/opt/learnharness-demo/scripts/demo/controller.mjs"]
