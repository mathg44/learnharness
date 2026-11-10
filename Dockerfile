# Verified in docs/server-baseline.md. Do not substitute a floating Node tag.
FROM node:26.13.0-bookworm@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853 AS dependencies
WORKDIR /workspace
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build && node scripts/container/assemble.mjs

# Network tools are inert in the unprivileged app. Only the separate guard
# receives NET_ADMIN, confined to its own network namespace.
FROM node:26.13.0-bookworm@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853 AS egress-tools
RUN apt-get update \
    && apt-get install -y --no-install-recommends nftables iproute2 \
    && rm -rf /var/lib/apt/lists/*

FROM egress-tools AS egress
COPY scripts/egress/ /usr/local/lib/learnharness/egress/
RUN mkdir -p /run/lh-egress \
    && chmod -R a-w /usr/local/lib/learnharness
USER 0:0
HEALTHCHECK --interval=1s --timeout=2s --start-period=5s --retries=2 \
    CMD ["node", "/usr/local/lib/learnharness/egress/healthcheck.mjs"]
ENTRYPOINT ["node", "/usr/local/lib/learnharness/egress/guard.mjs"]

FROM egress-tools AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 PORT=3000 \
    LH_DATA_DIR=/data LH_AUTH_FILE=/auth/auth.json \
    HOME=/tmp/home TMPDIR=/tmp \
    XDG_CONFIG_HOME=/tmp/config XDG_CACHE_HOME=/tmp/cache XDG_DATA_HOME=/tmp/xdg-data
COPY --from=build /workspace/.next/standalone ./
COPY scripts/container/entrypoint.sh scripts/container/healthcheck.mjs /usr/local/lib/learnharness/
COPY scripts/egress/ /usr/local/lib/learnharness/egress/
RUN mkdir -p /data /auth /app/.next/cache \
    && chown 1000:1000 /data /auth \
    && chmod 700 /data /auth \
    && chmod -R a-w /app /usr/local/lib/learnharness
USER 1000:1000
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "/usr/local/lib/learnharness/healthcheck.mjs"]
ENTRYPOINT ["/bin/sh", "/usr/local/lib/learnharness/entrypoint.sh"]
CMD ["node", "server.js"]
