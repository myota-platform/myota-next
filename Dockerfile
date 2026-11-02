FROM node:26-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build

ARG APP_NAME
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/activity/package.json ./apps/activity/package.json
COPY apps/activity-notifications/package.json ./apps/activity-notifications/package.json
COPY apps/activity-worker/package.json ./apps/activity-worker/package.json
COPY apps/email-worker/package.json ./apps/email-worker/package.json
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY apps/geodata/package.json ./apps/geodata/package.json
COPY apps/geodata-importer/package.json ./apps/geodata-importer/package.json
COPY apps/geodata-worker/package.json ./apps/geodata-worker/package.json
COPY apps/identity/package.json ./apps/identity/package.json
COPY apps/identity-maintenance/package.json ./apps/identity-maintenance/package.json
COPY apps/outbox-worker/package.json ./apps/outbox-worker/package.json
COPY apps/programmes/package.json ./apps/programmes/package.json
COPY vendor/shapefile ./vendor/shapefile
RUN npm ci
COPY . .
RUN test -n "$APP_NAME" \
  && npx nest build "$APP_NAME" \
  && test -f "dist/apps/$APP_NAME/main.js"

FROM node:26-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS osmium-build

RUN apt-get update \
  && apt-get install -y --no-install-recommends osmium-tool \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /out/usr/bin \
  && cp "$(command -v osmium)" /out/usr/bin/osmium \
  && ldd "$(command -v osmium)" \
    | awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// { print $1 }' \
    | sort -u \
    | while IFS= read -r library; do \
        case "$library" in \
          /lib64/ld-linux*|*/libc.so.6|*/libgcc_s.so.1|*/libm.so.6|*/libpthread.so.0|*/libdl.so.2|*/librt.so.1|*/libstdc++.so.6|*/libz.so.1|*/libzstd.so.1) continue ;; \
          /lib/*) destination="/out/usr$library" ;; \
          /usr/lib/*) destination="/out$library" ;; \
          *) continue ;; \
        esac; \
        mkdir -p "$(dirname "$destination")"; \
        cp -L "$library" "$destination"; \
      done

FROM node:26-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/shapefile ./vendor/shapefile
RUN npm ci --omit=dev \
  && npm cache clean --force

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba AS runtime

ARG APP_NAME
ENV APP_NAME=${APP_NAME}
ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/package-lock.json ./package-lock.json
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/vendor ./vendor
COPY --from=build /workspace/dist/apps/${APP_NAME}/ ./dist/apps/${APP_NAME}/
COPY --from=build /workspace/contracts ./contracts
COPY --from=build /workspace/libs/geodata-domain/data/es_ign_SPED2ETV2.tif ./libs/geodata-domain/data/es_ign_SPED2ETV2.tif
COPY --from=build /workspace/tools/start-app.mjs ./tools/start-app.mjs

CMD ["tools/start-app.mjs"]

FROM runtime AS geodata-worker
COPY --from=osmium-build /out/ /

FROM runtime AS app
