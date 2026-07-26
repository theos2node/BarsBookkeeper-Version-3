# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV BBK_DATA_DIR=/var/lib/bars-bookkeeper \
    BBK_SKIP_MODEL_SMOKE=1 \
    NODE_ENV=production \
    OPENCLAW_USE_CODEX=0

RUN groupadd --system --gid 10001 barsbookkeeper \
    && useradd --system --uid 10001 --gid barsbookkeeper --home-dir /var/lib/bars-bookkeeper barsbookkeeper \
    && mkdir -p /var/lib/bars-bookkeeper \
    && chown barsbookkeeper:barsbookkeeper /var/lib/bars-bookkeeper

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY CHANGELOG.md LICENSE README.md SECURITY.md ./

USER barsbookkeeper
VOLUME ["/var/lib/bars-bookkeeper"]

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["doctor"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "dist/cli/index.js", "healthcheck"]
