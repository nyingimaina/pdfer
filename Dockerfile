# PDfEr engine — single container (engine + pinned Chromium renderer)
#
# Runtime base is the pinned Gotenberg image so the renderer is byte-identical
# to the one recorded in provenance. Node is added from the official slim image;
# the two share a glibc-compatible Debian base.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The image does not ship if the engine's own suite fails.
COPY src ./src
COPY test ./test
COPY conformance ./conformance
RUN node --test test/*.test.js && node conformance/run.js

FROM gotenberg/gotenberg:8.40.0@sha256:53073e798c8ef39ea2187e44cb67bab77894ea2509100b94c4fe3b461f7b2996

USER root

# Node runtime (same major/minor as the deps stage).
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    PDFER_DATA_DIR=/data \
    HOME=/tmp \
    TZ=UTC

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY schema ./schema
COPY README.md ./
COPY NOTICE ./

ARG VERSION=1.1.0

LABEL org.opencontainers.image.title="PDfEr" \
      org.opencontainers.image.description="Templated document engine (Liquid to HTML to PDF)" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.documentation="https://hub.docker.com/r/nyingi/pdfer" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="PDfEr" \
      org.opencontainers.image.base.name="gotenberg/gotenberg:8.40.0"

# A self-sufficient font bundle for the demo tenant (SPEC AB4).
# Note: the Gotenberg base carries Chromium plus LibreOffice. LibreOffice is
# unused (its routes are disabled at run time) and cannot be removed without
# shrinking the parent layer, so the image is ~1.9 GB. See SPEC §6 RP1.
RUN mkdir -p /app/seed/assets \
 && cp /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
       /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
       /app/seed/assets/ \
 && mkdir -p /data \
 && chown -R 1001:1001 /app /data

USER 1001

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/src/server.js"]
